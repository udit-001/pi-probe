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
import { DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC, runProbe } from "./src/probe.ts";

const ProbeParams = Type.Object({
	code: Type.String({
		description:
			"Python source to run. Must be self-contained: it carries its own imports and setup, " +
			"because every call starts a new process with nothing remembered.",
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

const EMPTY_CONFIG: ProbeConfig = { allowedPackages: [], extraEnv: [] };

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

async function loadConfig(): Promise<ProbeConfig> {
	const override = process.env.PI_PROBE_CONFIG;
	const candidates = override
		? [override]
		: [join(dirname(fileURLToPath(import.meta.url)), "probe.config.json")];
	for (const path of candidates) {
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			if (parsed && typeof parsed === "object") {
				const config = parsed as ProbeConfig;
				return {
					allowedPackages: config.allowedPackages ?? [],
					extraEnv: config.extraEnv ?? [],
				};
			}
		} catch {
			// No config is the normal case: the tool works with nothing configured.
		}
	}
	return EMPTY_CONFIG;
}

const DESCRIPTION = `Run throwaway Python and get the answer, in one call.

Use this to check a value, see how a library behaves, inspect data, or try an idea
before writing it into a file. Each call is a new process, so the code must be
standalone -- it carries its own imports and setup.

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
	let config: ProbeConfig = EMPTY_CONFIG;
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
			"probe cells are standalone, so a probe never continues from an earlier one.",
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

			const decision = authorizeDeps(readDeclaredDeps(code), {
				allowedPackages: config.allowedPackages ?? [],
			}, approved);

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

			const details = {
				code,
				exitCode: outcome.exitCode,
				timedOut: outcome.timedOut,
				aborted: outcome.aborted,
				truncated: outcome.truncated,
				durationMs: outcome.durationMs,
				droppedEnv: outcome.droppedEnv,
				stdout: outcome.stdout,
				stderr: outcome.stderr,
			};

			return { content: [{ type: "text", text: render(outcome) }], details };
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as
				| { exitCode: number | null; timedOut: boolean; durationMs: number; stdout: string; stderr: string }
				| undefined;
			if (!d) return lines(theme.fg("dim", "probe"));

			const status = d.timedOut
				? theme.fg("warning", "timed out")
				: d.exitCode === 0
					? theme.fg("success", `ok ${d.durationMs}ms`)
					: theme.fg("error", `exit ${d.exitCode}`);

			if (!expanded) {
				const first = d.stdout.split("\n").find((line) => line.trim());
				const preview = first ? theme.fg("dim", first.slice(0, 70)) : "";
				return lines(preview ? `${status} ${preview}` : status);
			}

			const out: string[] = [status];
			if (d.stdout) out.push(theme.fg("dim", d.stdout.replace(/\n$/, "")));
			if (d.stderr.trim()) out.push(theme.fg("error", d.stderr.replace(/\n$/, "")));
			return lines(...out);
		},
	});
}

/** Shape one probe's outcome as the text the model reads. */
function render(outcome: {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
	durationMs: number;
	droppedEnv: string[];
}): string {
	const parts: string[] = [];

	if (outcome.timedOut) {
		parts.push(
			`Timed out after ${Math.round(outcome.durationMs / 1000)}s and was killed. ` +
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
		parts.push(
			`Note: probe does not pass through ${outcome.droppedEnv.join(", ")}. ` +
				"A probe cannot read your credentials.",
		);
	}

	return parts.join("\n\n");
}
