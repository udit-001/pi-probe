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
import { keyHint, keyText, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { authorizeDeps, readDeclaredDeps } from "./src/deps.ts";
import { DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC, runProbe, type ProbeOutcome } from "./src/probe.ts";
import { resolveWorkspace } from "./src/workspace.ts";
import { callView, collapsedView, expandedView, textView, type ViewTheme } from "./src/view.ts";

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

/**
 * pi's theme, adapted to the view port.
 *
 * This is the one impure adapter in the repo, and it is here on purpose.
 * `keyHint` reads process-global theme and keybinding state and throws outside
 * a live TUI, so it is resolved at the edge, once, where a terminal exists.
 * Everything behind the port is pure and can be tested in a bare process.
 */
function tuiTheme(theme: Theme): ViewTheme {
	// `keyHint` is `key + " to expand"`, and it renders an empty key as a
	// leading space rather than nothing. A registry that has not loaded yet
	// would leave the line saying "5 earlier lines,  to expand" -- so the
	// fallback carries the meaning without the gap.
	const key = keyText("app.tools.expand");
	return {
		fg: (color, text) => theme.fg(color, text),
		bold: (text) => theme.bold(text),
		expandHint: key ? keyHint("app.tools.expand", "to expand") : "expand to see the rest",
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

			// `details` carries the whole outcome, so every rendering of this run
			// -- the model's text, the shut view, the open view -- is built from
			// one object.
			const details = { ...outcome, code };

			return { content: [{ type: "text", text: textView(outcome) }], details };
		},

		// A probe can run for a minute with nothing on screen. Quoting the
		// expression that will produce the value is what makes the wait legible.
		renderCall(args, theme) {
			return lines(callView(args as { code: string; timeout?: number }, tuiTheme(theme)));
		},

		// Both views and the model's text come out of the same decomposition, so
		// the state label, the trailing-newline trim, and the stderr label are
		// each decided once rather than per view.
		renderResult(result, { expanded }, theme) {
			const view = tuiTheme(theme);
			const outcome = result.details as ProbeOutcome;
			return lines(...(expanded ? expandedView(outcome, view) : collapsedView(outcome, view)));
		},
	});
}
