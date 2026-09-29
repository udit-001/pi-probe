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
 * to forget.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { authorizeDeps, readDeclaredDeps } from "./src/deps.ts";
import { DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC, runProbe, type ProbeOutcome } from "./src/probe.ts";

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
before writing it into a file. The code is self-contained and each call starts
from a clean process.

The value of the last expression is printed for you, so end with the thing you
want to see rather than wrapping it in print().

To use third-party packages, declare them in a header at the very top:

    # /// script
    # dependencies = ["pandas"]
    # ///
    import pandas as pd
    print(pd.read_csv("data.csv").shape)

Returns stdout, stderr, and the value of the last expression. Packages you have
not approved before are confirmed with the user first.

For edits use edit. For code that is not throwaway, write a file and run it.`;

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
		promptSnippet: "probe: run throwaway Python for an answer, in a fresh process",
		promptGuidelines: [
			"Prefer probe over write-then-run when the code is throwaway: it is one call instead of three.",
			"Each probe is independent; restate whatever a probe needs rather than expecting a predecessor.",
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
			});

			if (outcome.spawnError) throw new Error(outcome.spawnError);

			// `details` carries the whole outcome, so the renderer and the
			// model-facing text are both built from one object.
			const details = { ...outcome, code };

			return { content: [{ type: "text", text: render(outcome) }], details };
		},

		// Reuses the same text the model reads, rather than re-deriving the
		// status line and the trailing-newline trim in a second place.
		renderResult(result, { expanded }, theme) {
			const text = render(result.details as ProbeOutcome);
			if (expanded) return lines(text);
			const first = text.split("\n").find((line) => line.trim()) ?? "probe";
			return lines(theme.fg("dim", first.slice(0, 80)));
		},
	});
}

/** Shape one probe's outcome as the text the model reads. Exported for tests. */
export function render(outcome: ProbeOutcome): string {
	const parts: string[] = [];

	if (outcome.timedOut) {
		// Timed out installing and timed out computing need opposite advice.
		// The runner touches a marker file the instant user code starts, so this
		// is a fact rather than a guess about what uv printed.
		const spentInstalling = !outcome.codeStarted && outcome.declaredDeps > 0;
		parts.push(
			spentInstalling
				? `Timed out after ${Math.round(outcome.durationMs / 1000)}s before the code ran. ` +
						`${outcome.declaredDeps} package(s) were declared, so the budget went to ` +
						"installing them. Retry with a higher timeout; the install is cached, so the " +
						"retry gets the whole budget for the code."
				: `Timed out after ${Math.round(outcome.durationMs / 1000)}s and was killed. ` +
						"Raise the timeout if the work is legitimate, or narrow the code.",
		);
	} else if (outcome.aborted) {
		parts.push("Cancelled before it finished.");
	} else if (outcome.exitCode === 0) {
		parts.push(`ok (${outcome.durationMs}ms)`);
	} else {
		parts.push(`Exited ${outcome.exitCode} (${outcome.durationMs}ms)`);
	}

	if (outcome.stdout) parts.push(outcome.stdout.replace(/\n$/, ""));
	// uv writes install and resolution progress here, so it is only worth
	// showing when something actually went wrong or needs installing.
	if (outcome.stderr.trim()) parts.push(`stderr:\n${outcome.stderr.replace(/\n$/, "")}`);
	if (outcome.droppedEnv.length > 0) {
		// Scoped claim on purpose. The environment is built from a fixed list,
		// so a probe cannot read these -- but it runs as you and can still open
		// a file under your home directory, which is a different thing entirely.
		parts.push(
			`Note: probe did not pass through ${outcome.droppedEnv.join(", ")}, so its ` +
				"environment does not carry those values.",
		);
	}

	return parts.join("\n\n");
}
