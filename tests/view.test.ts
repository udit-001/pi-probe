import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProbeOutcome } from "../src/probe.ts";
import { callView, collapsedView, expandedView, textView, type ViewColor, type ViewTheme } from "../src/view.ts";

/**
 * The identity adapter: the second of the two adapters that satisfy the view
 * port. It is what makes the colour choices assertable -- with it, every
 * assertion below is about the words, and `recording` is about the tokens.
 */
const theme: ViewTheme = { fg: (_color, text) => text, bold: (text) => text, expandHint: "Ctrl+O to expand" };

/** The same port, but remembering which token each fragment was given. */
function recording() {
	const seen: [ViewColor, string][] = [];
	const port: ViewTheme = {
		fg: (color, text) => {
			seen.push([color, text]);
			return text;
		},
		bold: text => text,
		expandHint: "Ctrl+O to expand",
	};
	return { seen, port, tokenFor: (fragment: string) => seen.find(([, text]) => text === fragment)?.[0] };
}

const base: ProbeOutcome = {
	stdout: "",
	stderr: "",
	exitCode: 0,
	timedOut: false,
	aborted: false,
	truncated: false,
	droppedEnv: [],
	durationMs: 595,
	declaredDeps: 0,
	codeStarted: true,
	spawnError: undefined,
	timeoutSec: 60,
};

describe("the call line, which is the only thing on screen while a probe runs", () => {
	it("quotes the expression that will produce the value, not the setup", () => {
		const line = callView({ code: 'import pandas as pd\n\ndf.dropna().groupby("lang").size()\n' }, theme);
		assert.equal(line, "probe  df.dropna().groupby(\"lang\").size()");
	});

	it("skips the dependency header and the comments around it", () => {
		const code = '# /// script\n# dependencies = ["pandas"]\n# ///\nimport pandas as pd\n# and now\nsum(range(3))\n';
		assert.equal(callView({ code }, theme), "probe  sum(range(3))");
	});

	it("shows the timeout that was asked for, and omits it when none was", () => {
		assert.equal(callView({ code: "1\n", timeout: 120 }, theme), "probe  1 (timeout 120s)");
		assert.equal(callView({ code: "1\n" }, theme), "probe  1");
	});

	it("clips a long expression instead of taking over the line", () => {
		const line = callView({ code: `x = ${"a".repeat(200)}\n` }, theme);
		assert.ok(line.length < 80, `expected a short line, got ${line.length} chars`);
		assert.ok(line.endsWith("…"), "a clipped line should say so");
	});

	it("has something to show for a cell that is only comments", () => {
		assert.equal(callView({ code: "# just a note\n" }, theme), "probe  …");
	});
});

describe("the shut view a human scans", () => {
	it("puts the value above the receipt", () => {
		const lines = collapsedView({ ...base, stdout: "{'providers': 225}\n" }, theme);
		assert.deepEqual(lines, ["", "  {'providers': 225}", "ok · 0.6s"]);
	});

	it("keeps the last lines, where a probe's answer lives", () => {
		const stdout = Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
		const lines = collapsedView({ ...base, stdout }, theme);
		assert.deepEqual(lines, [
			"",
			"  ... 5 earlier lines, Ctrl+O to expand",
			"  line6",
			"  line7",
			"  line8",
			"ok · 0.6s",
		]);
	});

	it("shows the traceback when the probe failed", () => {
		const lines = collapsedView({ ...base, exitCode: 1, stderr: "ValueError: boom\n" }, theme);
		assert.deepEqual(lines, ["", "  ValueError: boom", "Exited 1 · 0.6s"]);
	});

	it("prefers the traceback to whatever the cell printed on its way out", () => {
		const outcome = { ...base, exitCode: 1, stdout: "working...\ndone\n", stderr: "ValueError: boom\n" };
		assert.deepEqual(collapsedView(outcome, theme), ["", "  ValueError: boom", "Exited 1 · 0.6s"]);
	});

	it("does not let the environment note stand in for a missing answer", () => {
		const lines = collapsedView({ ...base, droppedEnv: ["GITHUB_TOKEN"] }, theme);
		assert.deepEqual(lines, ["", "ok · 0.6s"]);
	});

	it("reads a long run in units a scanning eye can parse", () => {
		assert.equal(collapsedView({ ...base, durationMs: 43_210 }, theme).at(-1), "ok · 43.2s");
		assert.equal(collapsedView({ ...base, durationMs: 125_000 }, theme).at(-1), "ok · 2m 5s");
		assert.equal(collapsedView({ ...base, durationMs: 3_780_000 }, theme).at(-1), "ok · 1h 3m");
	});
});

/**
 * The timeout advice used to live inside the status line, which the shut view
 * then clipped to 80 characters -- so the one state with something to do about
 * it was the one state whose advice was guaranteed to be cut.
 */
describe("the timeout advice survives being collapsed", () => {
	const installTimeout: ProbeOutcome = {
		...base,
		timedOut: true,
		exitCode: null,
		durationMs: 60_000,
		codeStarted: false,
		declaredDeps: 2,
		timeoutSec: 60,
	};

	it("gives each piece of advice its own uncapped line", () => {
		const lines = collapsedView(installTimeout, theme);
		for (const line of lines) assert.ok(line.length <= 100, `expected an uncapped line, got ${line.length} chars: ${line}`);
	});

	it("names a timeout the reader could actually have asked for", () => {
		const lines = collapsedView(installTimeout, theme);
		const retry = lines.find(line => line.includes("Retry"));
		assert.match(retry ?? "", /Retry with timeout:180/);
		assert.ok(180 > installTimeout.timeoutSec, "a retry must ask for more than the run that failed");
	});

	it("does not suggest a number the schema would reject", () => {
		const lines = collapsedView({ ...installTimeout, timeoutSec: 600 }, theme);
		const retry = lines.find(line => line.includes("Retry")) ?? lines.find(line => line.includes("ceiling"));
		assert.ok(retry, "an unsatisfiable suggestion should become different advice");
		assert.doesNotMatch(retry, /timeout:600/, "re-suggesting the timeout that just failed is no advice at all");
	});

	it("blames the installer only when the code never started", () => {
		const installing = collapsedView(installTimeout, theme).join(" ");
		const computing = collapsedView({ ...installTimeout, codeStarted: true }, theme).join(" ");
		assert.match(installing, /installing 2 package\(s\)/);
		assert.doesNotMatch(computing, /installing/);
		assert.match(computing, /narrow the code/);
	});

	it("gives a cancelled run no advice, because the reader caused it", () => {
		const lines = collapsedView({ ...base, timedOut: false, aborted: true, exitCode: null }, theme);
		assert.deepEqual(lines, ["", "  [cancelled before it finished]", "cancelled · 0.6s"]);
	});
});

describe("an output the cell never finished writing", () => {
	const truncated: ProbeOutcome = { ...base, truncated: true, stdout: "head\n\n[... omitted ...]\n\n{'a': 1}\n" };

	it("says so in the shut view, where a gap in the output would otherwise read as the cell's", () => {
		assert.match(collapsedView(truncated, theme).join("\n"), /\[Truncated: .*200KB capture limit/);
	});

	it("says so to the model too, which cannot see the gap for what it is", () => {
		assert.match(textView(truncated), /Note: Truncated: .*200KB capture limit/);
	});

	it("stays quiet when nothing was cut", () => {
		assert.doesNotMatch(textView(base), /Truncated/);
	});
});

describe("the model-facing text", () => {
	it("blames a long computation when the code did start", () => {
		const text = textView({ ...base, timedOut: true, exitCode: null, declaredDeps: 3 });
		assert.match(text, /Raise the timeout/);
		assert.doesNotMatch(text, /installing them/);
	});

	it("blames the installer when the code never started and packages were declared", () => {
		const text = textView({ ...base, timedOut: true, exitCode: null, codeStarted: false, declaredDeps: 3 });
		assert.match(text, /before the code ran/);
		assert.match(text, /3 package\(s\) were declared/);
		assert.doesNotMatch(text, /Raise the timeout/);
	});

	it("does not blame an installer that had nothing to install", () => {
		assert.doesNotMatch(textView({ ...base, timedOut: true, exitCode: null, codeStarted: false }), /installing them/);
	});

	it("does not claim the environment is secret", () => {
		const text = textView({ ...base, droppedEnv: ["GITHUB_TOKEN"] });
		assert.match(text, /environment does not carry those values/);
		assert.doesNotMatch(text, /cannot read your credentials/);
	});
});

/**
 * Colour is the only thing the open view adds. The words are the model's
 * words, so a reader who expands gets the shape back rather than a second
 * document to reconcile against the first.
 */
describe("the open view is the model's text, tinted", () => {
	const outcome: ProbeOutcome = { ...base, stdout: "{'providers': 225}\n", droppedEnv: ["GITHUB_TOKEN"] };

	it("says the same words as the model text", () => {
		assert.equal(expandedView(outcome, theme).join("\n"), textView(outcome));
	});

	it("tells a diagnosis from an answer", () => {
		const ok = recording();
		expandedView(outcome, ok.port);
		assert.equal(ok.tokenFor("{'providers': 225}"), "toolOutput");
		assert.equal(ok.tokenFor("Note: probe did not pass through GITHUB_TOKEN, so its environment does not carry those values."), "dim");

		const failed = recording();
		expandedView({ ...base, exitCode: 1, stderr: "ValueError: boom\n" }, failed.port);
		assert.equal(failed.tokenFor("ValueError: boom"), "error");
		assert.equal(failed.tokenFor("Exited 1 (595ms)"), "error");
	});

	it("tells a routine failure from an abnormal one", () => {
		const routine = recording();
		collapsedView({ ...base, exitCode: 1, stderr: "ValueError: boom\n" }, routine.port);
		assert.equal(routine.tokenFor("Exited 1"), "error");

		const abnormal = recording();
		collapsedView({ ...base, timedOut: true, exitCode: null, durationMs: 60_000 }, abnormal.port);
		assert.equal(abnormal.tokenFor("timed out"), "warning");
		assert.equal(abnormal.tokenFor("  [timed out after 1m 0s and was killed]"), "warning");
	});

	it("adds the advice the shut view led with, on top of the model's text", () => {
		const computing = { ...base, timedOut: true, exitCode: null, durationMs: 60_000, timeoutSec: 60 };
		const open = expandedView(computing, theme).join("\n");
		assert.match(open, /Timed out after 60s and was killed/, "the model's sentence is still there");
		assert.match(open, /Raise the timeout if the work is legitimate/, "and so is the advice");

		const installing = { ...computing, codeStarted: false, declaredDeps: 2 };
		assert.match(expandedView(installing, theme).join("\n"), /Retry with timeout:180/);
	});
});
