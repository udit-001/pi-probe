/**
 * probe -- run throwaway Python and get the answer.
 *
 * The tool surface is deliberately one call with one argument. Everything
 * else -- a scratch directory, a fresh process, a bounded environment, a
 * dependency check, and a kill that takes the whole process tree with it --
 * lives behind `runProbe` and never reaches the caller.
 *
 * Every call is a new process with an empty namespace, so a probe cannot read
 * a variable it did not define. That is what makes it safe to hand a model a
 * tool for scribbling on: there is no residue to reason about, and no reset
 * to forget. The one explicit exception is the session workspace -- a
 * directory keyed by the pi session id, which the cell reaches through the
 * WORKSPACE constant. It holds whatever an expensive step left for later
 * probes in the same conversation, and dies with the OS's temp policy, not
 * with the process.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { authorizeDeps, readDeclaredDeps } from "./src/deps.ts";
import { DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC, runProbe, type ProbeOutcome } from "./src/probe.ts";
import { resolveWorkspace } from "./src/workspace.ts";

const ProbeParams = Type.Object({
	code: Type.String({
		description:
			"Python source. Self-contained: it carries its own imports and setup, and each call " +
			"starts from a clean process.",
	}),
	timeout: Type.Optional(
		Type.Number({
			description: `Seconds before the run is killed. Default ${DEFAULT_TIMEOUT_SEC}.`,
			minimum: 1,
			maximum: MAX_TIMEOUT_SEC,
		}),
	),
});

interface ProbeConfig {
	allowedPackages?: string[];
	extraEnv?: string[];
}

/** What `loadConfig` always hands back: every field present, no undefined. */
interface ResolvedConfig {
	allowedPackages: string[];
	extraEnv: string[];
}

const EMPTY_CONFIG: ResolvedConfig = { allowedPackages: [], extraEnv: [] };

/**
 * A render result is just something that turns into lines. Implementing that
 * here rather than importing pi's TUI package keeps the extension working
 * across pi versions -- that package is nested inside pi's own install, not
 * published for extensions to depend on.
 */
function lines(...items: string[]): { render(): string[]; invalidate(): void } {
	return {
		render: () => items.flatMap((item) => item.split("\n")),
		invalidate: () => {},
	};
}

async function loadConfig(): Promise<ResolvedConfig> {
	// A missing or unreadable config is the normal case: the tool works with
	// nothing configured, and anything unreadable falls back to "nothing
	// allowed" rather than to something half-parsed.
	const path = process.env.PI_PROBE_CONFIG ?? join(dirname(fileURLToPath(import.meta.url)), "probe.config.json");
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!parsed || typeof parsed !== "object") return EMPTY_CONFIG;
		const config = parsed as ProbeConfig;
		return {
			allowedPackages: config.allowedPackages ?? [],
			extraEnv: config.extraEnv ?? [],
		};
	} catch {
		return EMPTY_CONFIG;
	}
}

const DESCRIPTION = `Run throwaway Python and get the answer, in one call.

Use this to check a value, see how a library behaves, inspect data, or try an idea
before writing it into a file. For edits use edit; for code that is not throwaway,
write a file and run it.

Fresh every call: each probe is a new process with an empty namespace. WORKSPACE is
the one thing the tool carries between calls -- a scratch directory tied to this
session, which survives a resume until the OS cleans the temp dir; a new session
gets fresh scratch. Do an expensive step once (a fetch, a slow parse), write its
result there, and read it back in later probes instead of redoing the step:

    with open(os.path.join(WORKSPACE, "models.json"), "w") as f: json.dump(data, f)
    data = json.load(open(os.path.join(WORKSPACE, "models.json")))

End with the thing you want to see. The value of the last expression is printed
for you when it is top-level, so you need no print() around it. An expression
indented inside a for, if, or try block is not top-level and prints nothing.

Third-party packages go in a PEP 723 header at the very top, and you approve each
new package once per session (URLs and local paths are refused):

    # /// script
    # dependencies = ["pandas"]
    # ///
    import pandas as pd
    print(pd.read_csv("data.csv").shape)

The environment is stdlib Python under uv. A fetch is plain urllib; a server that
answers 403 usually wants a browser User-Agent header. A crash still returns
everything printed before it, so fix the tail and rerun instead of rewriting the
whole probe.`;

/**
 * The stable identity a workspace is keyed to: the pi session id, falling
 * back to the session file path (also stable across a resume), then nothing
 * (headless/print modes), which yields a fresh random directory per call.
 */
function workspaceIdentity(ctx: ExtensionContext): string | undefined {
	if (typeof ctx.sessionManager?.getSessionId === "function") {
		const id = ctx.sessionManager.getSessionId();
		if (id) return id;
	}
	if (typeof ctx.sessionManager?.getSessionFile === "function") {
		return ctx.sessionManager.getSessionFile() ?? undefined;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	// Approved-for-this-session package names. Cleared per session so a yes in
	// one conversation never authorises the next one.
	const approved = new Set<string>();
	let config: ResolvedConfig = EMPTY_CONFIG;
	let configLoaded = false;

	pi.on("session_start", async () => {
		approved.clear();
		if (!configLoaded) {
			config = await loadConfig();
			configLoaded = true;
		}
	});

	pi.registerTool({
		name: "probe",
		label: "Python probe",
		description: DESCRIPTION,
		promptSnippet: "probe: run throwaway Python for an answer, in a fresh process; WORKSPACE carries scratch between calls",
		promptGuidelines: [
			"Prefer probe over write-then-run when the code is throwaway: it is one call instead of three.",
			"Do an expensive step once and reuse it across probes: write the result to WORKSPACE, read it back in the next probe. Everything else restarts each call.",
		],
		parameters: ProbeParams,
		// Cells are independent, so parallel calls are safe and a batch of
		// probes does not serialise.
		executionMode: "parallel",

		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
			const code = params.code.trim();
			if (!code) throw new Error("probe needs some code to run");

			if (!configLoaded) {
				config = await loadConfig();
				configLoaded = true;
			}

			const decision = authorizeDeps(readDeclaredDeps(code), { allowedPackages: config.allowedPackages }, approved);

			if (decision.refused.length > 0) {
				throw new Error(
					`probe refuses dependencies given as a URL or path: ${decision.refused.join(", ")}. ` +
						`Name the package instead, so the version can be reviewed.`,
				);
			}

			if (decision.pendingKeys.length > 0) {
				if (!ctx.hasUI) {
					throw new Error(
						`probe needs approval for: ${decision.pendingKeys.join(", ")}. ` +
							`Add them to allowedPackages in probe.config.json to run without a prompt.`,
					);
				}
				const ok = await ctx.ui.confirm(
					"Install a Python package?",
					`probe wants to install ${decision.pendingKeys.join(", ")}.\n\n` +
						`This runs the package's code as you. Check the name is what you meant -- ` +
						`look-alike names are a common way in.`,
				);
				if (!ok) throw new Error("probe cancelled: package not approved");
				for (const key of decision.pendingKeys) approved.add(key);
			}

			const outcome = await runProbe({
				code,
				cwd: ctx.cwd,
				timeoutSec: params.timeout,
				signal,
				extraEnv: config.extraEnv,
				// Resolved per invocation: a resumed session resolves to the same
				// verified directory, so its data is still there to reuse.
				workspace: await resolveWorkspace(workspaceIdentity(ctx)),
			});

			if (outcome.spawnError) throw new Error(outcome.spawnError);

			// `details` carries the whole outcome, so the renderer and the
			// model-facing text are both built from one object.
			const details = { ...outcome, code };

			return { content: [{ type: "text", text: render(outcome) }], details };
		},

		// Both views are built from one decomposition of the outcome, so the
		// status line, the trailing-newline trim, and the stderr label are each
		// decided once.
		renderResult(result, { expanded }, theme) {
			const parts = renderParts(result.details as ProbeOutcome);
			if (expanded) return lines(joinParts(parts));
			return lines(...collapsed(parts, text => theme.fg("dim", text)));
		},
	});
}

const COLLAPSED_TAIL_LINES = 3;

/**
 * The collapsed TUI line: status, then the tail of the answer.
 *
 * A probe's answer is its last line, so the tail is the value and the status
 * line is only a receipt. Leading with the receipt is what made a human
 * supervising a run see `ok (595ms)` and nothing else. Same shape as bash,
 * which previews the tail of real output rather than the exit code.
 */
function collapsed(parts: RenderParts, dim: (text: string) => string): string[] {
	// The status line is capped like the old first-line view: the timeout advice
	// is two sentences, and a two-sentence collapsed line defeats the point of
	// collapsing. The full text is one expand away.
	const out = [dim(parts.status.length > 80 ? `${parts.status.slice(0, 79)}…` : parts.status)];
	// stderr outranks stdout: a failing probe usually prints the traceback and
	// nothing else, and that traceback is the whole diagnosis. The dropped-env
	// note never appears here -- it is a standing fact about the sandbox, not a
	// per-run result, and on a silent probe it would be the only thing shown.
	const body = parts.stderr || parts.stdout;
	if (!body) return out;
	const all = body.split("\n");
	const tail = all.slice(-COLLAPSED_TAIL_LINES);
	out.push(...tail.map(line => `  ${line}`));
	// Only worth saying when there is something above the cut to see.
	if (all.length > tail.length) {
		out.splice(1, 0, dim(`... ${all.length - tail.length} earlier lines, expand for all`));
	}
	return out;
}

/** Shape one probe's outcome as the text the model reads. Exported for tests. */
export function render(outcome: ProbeOutcome): string {
	return joinParts(renderParts(outcome));
}

/** The one place that decides labels and blank lines, so no caller has to. */
function joinParts({ status, stdout, stderr, note }: RenderParts): string {
	return [status, stdout, stderr && `stderr:\n${stderr}`, note].filter(Boolean).join("\n\n");
}

/**
 * A probe's outcome split by role, so a view picks by name and never by
 * position. Empty string means absent; `joinParts` is what turns that back
 * into text, and it owns the labels.
 */
interface RenderParts {
	status: string;
	stdout: string;
	stderr: string;
	note: string;
}

function renderParts(outcome: ProbeOutcome): RenderParts {
	let status: string;

	if (outcome.timedOut) {
		// Timed out installing and timed out computing need opposite advice.
		// The runner touches a marker file the instant user code starts, so this
		// is a fact rather than a guess about what uv printed.
		const spentInstalling = !outcome.codeStarted && outcome.declaredDeps > 0;
		status =
			spentInstalling
				? `Timed out after ${Math.round(outcome.durationMs / 1000)}s before the code ran. ` +
						`${outcome.declaredDeps} package(s) were declared, so the budget went to ` +
						"installing them. Retry with a higher timeout; the install is cached, so the " +
						"retry gets the whole budget for the code."
				: `Timed out after ${Math.round(outcome.durationMs / 1000)}s and was killed. ` +
						"Raise the timeout if the work is legitimate, or narrow the code.";
	} else if (outcome.aborted) {
		status = "Cancelled before it finished.";
	} else if (outcome.exitCode === 0) {
		status = `ok (${outcome.durationMs}ms)`;
	} else {
		status = `Exited ${outcome.exitCode} (${outcome.durationMs}ms)`;
	}

	return {
		status,
		stdout: outcome.stdout.replace(/\n$/, ""),
		// uv writes install and resolution progress here, so it is only worth
		// showing when something actually went wrong or needs installing.
		stderr: outcome.stderr.trim() ? outcome.stderr.replace(/\n$/, "") : "",
		note:
			outcome.droppedEnv.length > 0
				? // Scoped claim on purpose. The environment is built from a fixed list,
					// so a probe cannot read these -- but it runs as you and can still open
					// a file under your home directory, which is a different thing entirely.
					`Note: probe did not pass through ${outcome.droppedEnv.join(", ")}, so its ` +
					"environment does not carry those values."
				: "",
	};
}
