import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMetadataBlock, readDeclaredDeps, readRequiresPython } from "./deps.ts";
import { buildChildEnv } from "./env.ts";
import { buildRunner } from "./runner.ts";

/** How long a probe may run before it is killed. Generous: a cold install costs seconds. */
export const DEFAULT_TIMEOUT_SEC = 60;
export const MIN_TIMEOUT_SEC = 1;
export const MAX_TIMEOUT_SEC = 600;

/**
 * Cap on captured output. Past this we stop accumulating but keep draining, so
 * a runaway `print` cannot exhaust memory and does not kill a computation that
 * is otherwise fine.
 */
export const MAX_OUTPUT_BYTES = 200_000;

export interface RunProbeOptions {
	code: string;
	cwd: string;
	timeoutSec?: number;
	signal?: AbortSignal;
	/** Parent environment. Injected rather than read, so policy is testable. */
	parentEnv?: Readonly<Record<string, string | undefined>>;
	/** Env names a human blessed in probe.config.json. */
	extraEnv?: readonly string[];
	/**
	 * The per-session probe workspace. Exposed to the cell as WORKSPACE so an
	 * expensive step survives across probes; ownership of the directory (create,
	 * wipe) stays with the caller.
	 */
	workspace?: string;
	/** Injected in tests; production always spawns uv. */
	command?: string;
	commandArgs?: readonly string[];
}

export interface ProbeOutcome {
	stdout: string;
	stderr: string;
	/** Exit code, or null when the process was killed by a signal. */
	exitCode: number | null;
	/** Set when uv itself could not be started. */
	spawnError?: string;
	timedOut: boolean;
	aborted: boolean;
	truncated: boolean;
	/** Environment variables the policy refused to hand over. */
	droppedEnv: string[];
	/** How many packages the cell declared. Used to explain a timeout. */
	declaredDeps: number;
	/**
	 * Whether the interpreter reached the user's code at all. False after a
	 * timeout means the budget went to uv, not to the cell.
	 */
	codeStarted: boolean;
	durationMs: number;
}

/** Decode bytes, dropping a UTF-8 sequence cut in half by a byte boundary. */
function decodeTruncated(buf: Buffer): string {
	let end = buf.length;
	while (end > 0 && (buf[end - 1] as number) >= 0x80 && (buf[end - 1] as number) < 0xc0) end--;
	return buf.subarray(0, end).toString("utf8");
}

/**
 * Bounded output that keeps both ends.
 *
 * Head-and-tail, not head-only, because the part of a probe that matters is
 * almost always at the end: the value of the last expression, or the error
 * that stopped it. Dropping the tail to save memory throws away the answer.
 *
 * Everything is counted in bytes and held as bytes. Counting bytes while
 * slicing characters mixes the two units, and the omitted-byte count drifts
 * negative when it does.
 */
class CappedBuffer {
	private head: Buffer[] = [];
	private tail: Buffer = Buffer.alloc(0);
	private headBytes = 0;
	private totalBytes = 0;
	private readonly headCap: number;
	private readonly tailCap: number;
	readonly cap: number;

	constructor(cap: number) {
		this.cap = cap;
		this.headCap = Math.floor(cap / 2);
		this.tailCap = cap - this.headCap;
	}

	push(chunk: string | Buffer): void {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
		this.totalBytes += buf.length;

		const room = this.headCap - this.headBytes;
		if (room > 0) {
			const kept = buf.subarray(0, Math.min(room, buf.length));
			this.head.push(kept);
			this.headBytes += kept.length;
			this.tail = buf.length > kept.length ? buf.subarray(kept.length) : this.tail;
		} else {
			this.tail = Buffer.concat([this.tail, buf]);
		}

		if (this.tail.length > this.tailCap * 2) {
			this.tail = this.tail.subarray(this.tail.length - this.tailCap);
		}
	}

	get overflowed(): boolean {
		return this.totalBytes > this.cap;
	}

	text(): string {
		if (!this.overflowed) return decodeTruncated(Buffer.concat(this.head));
		const omitted = this.totalBytes - this.headBytes - this.tail.length;
		return [
			decodeTruncated(Buffer.concat(this.head)),
			`[... ${omitted} bytes omitted ...]`,
			this.tail.toString("utf8"),
		].join("\n");
	}
}

/**
 * Remove the scratch directory, retrying briefly.
 *
 * A just-exited child can still hold a handle for a moment -- reliably on
 * Windows, occasionally on Linux -- and the first `rm` can lose that race. The
 * retry is not speculative: an earlier swallowed failure here left an empty
 * directory behind with nothing in the logs to say so.
 */
async function removeScratch(dir: string): Promise<boolean> {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await rm(dir, { recursive: true, force: true });
			return true;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
		}
	}
	// Say so once. The alternative -- returning quietly -- is how an empty
	// directory survived a whole test run with nothing in the logs to explain it.
	console.error(`pi-probe: could not remove its scratch directory ${dir}`);
	return false;
}

/** Kill the process and anything it spawned. */
function killTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) return;
	if (process.platform === "win32") {
		// Windows has no process groups to signal, so ask the OS to walk the
		// tree for us. `taskkill` ships with the OS.
		spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		}).on("error", () => child.kill("SIGKILL"));
		return;
	}
	try {
		// Negative pid targets the group, which is why the child is detached.
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

/**
 * Run one throwaway cell.
 *
 * Every call is a fresh process with an empty namespace, so there is no state
 * to inherit and nothing to reset. That is the whole contract: a probe that
 * reads a variable it did not define is impossible rather than merely
 * unlikely. The one explicit exception is the workspace it is handed: a
 * directory it may read and write, which outlives the call when the caller
 * keeps it alive.
 */
export async function runProbe(options: RunProbeOptions): Promise<ProbeOutcome> {
	const {
		code,
		cwd,
		signal,
		parentEnv = process.env,
		extraEnv = [],
		command = "uv",
		commandArgs,
	} = options;

	const timeoutSec = Math.min(
		MAX_TIMEOUT_SEC,
		Math.max(MIN_TIMEOUT_SEC, options.timeoutSec ?? DEFAULT_TIMEOUT_SEC),
	);

	const { env, dropped } = buildChildEnv(parentEnv, {
		extraEnv,
		caseInsensitive: process.platform === "win32",
		forced: {
			// Unbuffered so stdout and stderr interleave in the order written.
			PYTHONUNBUFFERED: "1",
			PYTHONIOENCODING: "utf-8",
			...(options.workspace ? { PI_PROBE_WORKSPACE: options.workspace } : {}),
		},
	});

	const dir = await mkdtemp(join(tmpdir(), "pi-probe-"));
	const userPath = join(dir, "probe.py");
	const runnerPath = join(dir, "runner.py");
	const startedPath = join(dir, "started");
	const started = Date.now();

	const stdout = new CappedBuffer(MAX_OUTPUT_BYTES);
	const stderr = new CappedBuffer(MAX_OUTPUT_BYTES);
	const deps = readDeclaredDeps(code);
	let timedOut = false;
	let aborted = false;
	let spawnError: string | undefined;

	// A signal that is already aborted never fires `abort` at a listener added
	// afterwards, so without this the run would sail to the full timeout.
	if (signal?.aborted) {
		aborted = true;
	}

	try {
		await writeFile(userPath, code, { encoding: "utf8", mode: 0o600 });
		await writeFile(
			runnerPath,
			// Rebuilt from the parsed dependencies, not forwarded: a `[tool.uv]`
			// index override in the source must never redirect resolution.
			buildRunner(userPath, buildMetadataBlock(deps, readRequiresPython(code)), startedPath),
			{ encoding: "utf8", mode: 0o600 },
		);

		const args = commandArgs ?? ["run", "--script", runnerPath];

		const outcome = await new Promise<{ exitCode: number | null; spawnError?: string }>(
			(resolve) => {
				if (aborted) {
					resolve({ exitCode: null });
					return;
				}

				const child = spawn(command, [...args], {
					cwd,
					env,
					// Its own process group, so the timeout can take the whole
					// tree down rather than orphaning whatever code spawned.
					detached: process.platform !== "win32",
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});

				const timer = setTimeout(() => {
					timedOut = true;
					killTree(child);
				}, timeoutSec * 1000);

				const onAbort = () => {
					aborted = true;
					killTree(child);
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				const done = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				};

				child.stdout?.on("data", (c: Buffer) => stdout.push(c.toString("utf8")));
				child.stderr?.on("data", (c: Buffer) => stderr.push(c.toString("utf8")));

				child.on("error", (err: NodeJS.ErrnoException) => {
					done();
					resolve({
						exitCode: null,
						spawnError:
							err.code === "ENOENT"
								? `\`${command}\` was not found on PATH. pi-probe needs uv (https://docs.astral.sh/uv/).`
								: err.message,
					});
				});

				child.on("close", (code, sig) => {
					done();
					resolve({ exitCode: code ?? (sig ? null : 0) });
				});
			},
		);

		return {
			stdout: stdout.text(),
			stderr: stderr.text(),
			exitCode: outcome.exitCode,
			spawnError: outcome.spawnError,
			timedOut,
			aborted,
			truncated: stdout.overflowed || stderr.overflowed,
			droppedEnv: dropped,
			declaredDeps: deps.length,
			codeStarted: existsSync(startedPath),
			durationMs: Date.now() - started,
		};
	} finally {
		await removeScratch(dir);
	}
}
