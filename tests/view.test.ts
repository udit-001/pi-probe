import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProbeOutcome } from "../src/probe.ts";
import { callView, collapsedView, expandedView, textView, type ViewColor, type ViewPort, type VisualWrap } from "../src/view.ts";

/** Room enough that nothing wraps, so an assertion is about the words alone. */
const ROOMY = 200;
/** Narrow enough that a long line cannot help but wrap. */
const NARROW = 40;
/** Narrow enough that even the hint, 37 characters of it, must wrap. */
const TIGHT = 30;

/**
 * The test adapter's wrapping, and deliberately not pi's.
 *
 * pi word-wraps styled text and pads every line out to the width. If the
 * assertions below ran on that, "three visual lines" would be a statement
 * about pi's wrapping policy rather than about what these views decide, and
 * they would break when pi changed it. This one cuts plainly, in plain text,
 * and does not pad -- so a test pins the composition here and nothing else.
 */
function wrap(text: string, maxVisualLines: number, width: number): VisualWrap {
	const visualLines = text.split("\n").flatMap(line => {
		if (line.length <= width) return [line];
		const cut: string[] = [];
		for (let at = 0; at < line.length; at += width) cut.push(line.slice(at, at + width));
		return cut;
	});
	return {
		visualLines: visualLines.slice(-maxVisualLines),
		skippedCount: Math.max(0, visualLines.length - maxVisualLines),
	};
}

/**
 * The identity adapter: one of the two adapters that satisfy the view port. It
 * is what makes the colour choices assertable -- with it, every assertion below
 * is about the words, and `recording` is about the tokens.
 */
const identity: ViewPort = {
	fg: (_color, text) => text,
	bold: (text) => text,
	expandHint: "Ctrl+O to expand",
	wrap,
};

/** The same port, but remembering which token each fragment was given. */
function recording() {
	const seen: [ViewColor, string][] = [];
	const port: ViewPort = {
		fg: (color, text) => {
			seen.push([color, text]);
			return text;
		},
		bold: text => text,
		expandHint: "Ctrl+O to expand",
		wrap,
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
		const line = callView({ code: 'import pandas as pd\n\ndf.dropna().groupby("lang").size()\n' }, identity, ROOMY);
		assert.equal(line, "probe  df.dropna().groupby(\"lang\").size()");
	});

	it("skips the dependency header and the comments around it", () => {
		const code = '# /// script\n# dependencies = ["pandas"]\n# ///\nimport pandas as pd\n# and now\nsum(range(3))\n';
		assert.equal(callView({ code }, identity, ROOMY), "probe  sum(range(3))");
	});

	it("shows the timeout that was asked for, and omits it when none was", () => {
		assert.equal(callView({ code: "1\n", timeout: 120 }, identity, ROOMY), "probe  1 (timeout 120s)");
		assert.equal(callView({ code: "1\n" }, identity, ROOMY), "probe  1");
	});

	it("clips a long expression instead of taking over the line", () => {
		const line = callView({ code: `x = ${"a".repeat(200)}\n` }, identity, ROOMY);
		assert.ok(line.length < 80, `expected a short line, got ${line.length} chars`);
		assert.ok(line.endsWith("…"), "a clipped line should say so");
	});

	it("clips to the width it was handed, not to a fixed guess", () => {
		const line = callView({ code: `x = ${"a".repeat(200)}\n` }, identity, 50);
		assert.ok(line.length <= 50, `expected at most 50 chars, got ${line.length}: ${line}`);
		assert.ok(line.endsWith("…"), "a clipped line should say so");
	});

	it("keeps the timeout visible even on a terminal with no room for the expression", () => {
		const line = callView({ code: `x = ${"a".repeat(200)}\n`, timeout: 120 }, identity, 30);
		assert.ok(line.endsWith(" (timeout 120s)"), `the receipt should survive, got: ${line}`);
		assert.ok(line.length <= 30, `expected at most 30 chars, got ${line.length}: ${line}`);
	});

	it("has something to show for a cell that is only comments", () => {
		assert.equal(callView({ code: "# just a note\n" }, identity, ROOMY), "probe  …");
	});
});

describe("the shut view a human scans", () => {
	it("puts the value above the receipt", () => {
		const lines = collapsedView({ ...base, stdout: "{'providers': 225}\n" }, identity, ROOMY);
		assert.deepEqual(lines, ["", "  {'providers': 225}", "ok · 0.6s"]);
	});

	it("keeps the last lines, where a probe's answer lives", () => {
		const stdout = Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
		const lines = collapsedView({ ...base, stdout }, identity, ROOMY);
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
		const lines = collapsedView({ ...base, exitCode: 1, stderr: "ValueError: boom\n" }, identity, ROOMY);
		assert.deepEqual(lines, ["", "  ValueError: boom", "Exited 1 · 0.6s"]);
	});

	it("prefers the traceback to whatever the cell printed on its way out", () => {
		const outcome = { ...base, exitCode: 1, stdout: "working...\ndone\n", stderr: "ValueError: boom\n" };
		assert.deepEqual(collapsedView(outcome, identity, ROOMY), ["", "  ValueError: boom", "Exited 1 · 0.6s"]);
	});

	it("does not let the environment note stand in for a missing answer", () => {
		const lines = collapsedView({ ...base, droppedEnv: ["GITHUB_TOKEN"] }, identity, ROOMY);
		assert.deepEqual(lines, ["", "ok · 0.6s"]);
	});

	it("reads a long run in units a scanning eye can parse", () => {
		assert.equal(collapsedView({ ...base, durationMs: 43_210 }, identity, ROOMY).at(-1), "ok · 43.2s");
		assert.equal(collapsedView({ ...base, durationMs: 125_000 }, identity, ROOMY).at(-1), "ok · 2m 5s");
		assert.equal(collapsedView({ ...base, durationMs: 3_780_000 }, identity, ROOMY).at(-1), "ok · 1h 3m");
	});
});

/**
 * A cell that printed one long line used to hand the terminal a single string
 * wider than the screen, so the terminal wrapped it with no gutter and the
 * shut view's three-line budget bought one fragment. Wrapping here is what
 * makes the budget a budget.
 */
describe("the shut view laid out to the terminal", () => {
	const long = `${"x".repeat(NARROW * 4)}\n`;

	it("wraps a long line itself, and indents every visual line it makes", () => {
		const lines = collapsedView({ ...base, stdout: long }, identity, NARROW);
		for (const line of lines) assert.ok(line.length <= NARROW, `line too wide: ${line.length} chars: ${line}`);
		assert.equal(lines.filter(line => line.startsWith("  x")).length, 3, "three visual lines of output");
	});

	it("counts what the reader cannot see, which is not what the cell wrote", () => {
		// Three lines, each two-and-a-bit times the width, so nine visual lines
		// of which three survive. A count of "3 earlier" would be counting the
		// cell's lines, which is not what the reader is missing.
		const three = Array.from({ length: 3 }, () => "y".repeat(NARROW * 2)).join("\n") + "\n";
		const lines = collapsedView({ ...base, stdout: three }, identity, NARROW);
		assert.equal(lines[1], "  ... 6 earlier lines, Ctrl+O to expand");
		assert.equal(lines.filter(line => line.startsWith("  y")).length, 3);
	});

	it("wraps the advice rather than clipping it, since the reader needs all of it", () => {
		const lines = collapsedView({ ...base, timedOut: true, exitCode: null, durationMs: 60_000 }, identity, NARROW);
		for (const line of lines) assert.ok(line.length <= NARROW, `line too wide: ${line.length} chars: ${line}`);

		// Wrapped, not clipped: it starts where it should and ends where it
		// should. Asserted this way so it holds for any host's wrapping, not
		// just the plain one above.
		const advice = lines.filter(line => line.trim() && !line.startsWith("  [") && !line.startsWith("timed out ·"));
		assert.ok(advice.length > 1, `expected the advice to wrap, got: ${advice.join(" | ")}`);
		assert.match(advice[0] ?? "", /Raise the timeout/);
		assert.match(advice.at(-1) ?? "", /narrow the code/);
	});

	it("keeps the whole hint on a terminal too narrow to hold it on one line", () => {
		const stdout = Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
		const lines = collapsedView({ ...base, stdout }, identity, TIGHT);
		const hint = lines.slice(1, lines.indexOf("  line6"));
		assert.ok(hint.length > 1, `the hint should have wrapped, got: ${lines.join(" | ")}`);
		assert.equal(hint.join(" ").replace(/\s+/g, " "), " ... 5 earlier lines, Ctrl+O to expand");
	});

	it("lays out at a width too small to be real rather than throwing", () => {
		for (const width of [0, -5, Number.NaN]) {
			const lines = collapsedView({ ...base, stdout: long }, identity, width);
			assert.ok(lines.length > 0, `expected lines at width ${width}`);
			assert.equal(lines.at(-1), "ok · 0.6s", `expected the receipt at width ${width}`);
		}
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
		const lines = collapsedView(installTimeout, identity, ROOMY);
		for (const line of lines) assert.ok(line.length <= 100, `expected an uncapped line, got ${line.length} chars: ${line}`);
	});

	it("names a timeout the reader could actually have asked for", () => {
		const lines = collapsedView(installTimeout, identity, ROOMY);
		const retry = lines.find(line => line.includes("Retry"));
		assert.match(retry ?? "", /Retry with timeout:180/);
		assert.ok(180 > installTimeout.timeoutSec, "a retry must ask for more than the run that failed");
	});

	it("does not suggest a number the schema would reject", () => {
		const lines = collapsedView({ ...installTimeout, timeoutSec: 600 }, identity, ROOMY);
		const retry = lines.find(line => line.includes("Retry")) ?? lines.find(line => line.includes("ceiling"));
		assert.ok(retry, "an unsatisfiable suggestion should become different advice");
		assert.doesNotMatch(retry, /timeout:600/, "re-suggesting the timeout that just failed is no advice at all");
	});

	it("blames the installer only when the code never started", () => {
		const installing = collapsedView(installTimeout, identity, ROOMY).join(" ");
		const computing = collapsedView({ ...installTimeout, codeStarted: true }, identity, ROOMY).join(" ");
		assert.match(installing, /installing 2 package\(s\)/);
		assert.doesNotMatch(computing, /installing/);
		assert.match(computing, /narrow the code/);
	});

	it("gives a cancelled run no advice, because the reader caused it", () => {
		const lines = collapsedView({ ...base, timedOut: false, aborted: true, exitCode: null }, identity, ROOMY);
		assert.deepEqual(lines, ["", "  [cancelled before it finished]", "cancelled · 0.6s"]);
	});
});

describe("an output the cell never finished writing", () => {
	const truncated: ProbeOutcome = { ...base, truncated: true, stdout: "head\n\n[... omitted ...]\n\n{'a': 1}\n" };

	it("says so in the shut view, where a gap in the output would otherwise read as the cell's", () => {
		assert.match(collapsedView(truncated, identity, ROOMY).join("\n"), /\[Truncated: .*200KB capture limit/);
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
 * Colour is the only thing the open view adds, and on a terminal wide enough
 * not to wrap, so is the layout. The words are the model's words, so a reader
 * who expands gets the shape back rather than a second document to reconcile
 * against the first.
 */
describe("the open view is the model's text, tinted", () => {
	const outcome: ProbeOutcome = { ...base, stdout: "{'providers': 225}\n", droppedEnv: ["GITHUB_TOKEN"] };

	it("says the same words as the model text", () => {
		assert.equal(expandedView(outcome, identity, ROOMY).join("\n"), textView(outcome));
	});

	it("tells a diagnosis from an answer", () => {
		const ok = recording();
		expandedView(outcome, ok.port, ROOMY);
		assert.equal(ok.tokenFor("{'providers': 225}"), "toolOutput");
		assert.equal(ok.tokenFor("Note: probe did not pass through GITHUB_TOKEN, so its environment does not carry those values."), "dim");

		const failed = recording();
		expandedView({ ...base, exitCode: 1, stderr: "ValueError: boom\n" }, failed.port, ROOMY);
		assert.equal(failed.tokenFor("ValueError: boom"), "error");
		assert.equal(failed.tokenFor("Exited 1 (595ms)"), "error");
	});

	it("tells a routine failure from an abnormal one", () => {
		const routine = recording();
		collapsedView({ ...base, exitCode: 1, stderr: "ValueError: boom\n" }, routine.port, ROOMY);
		assert.equal(routine.tokenFor("Exited 1"), "error");

		const abnormal = recording();
		collapsedView({ ...base, timedOut: true, exitCode: null, durationMs: 60_000 }, abnormal.port, ROOMY);
		assert.equal(abnormal.tokenFor("timed out"), "warning");
		assert.equal(abnormal.tokenFor("[timed out after 1m 0s and was killed]"), "warning");
	});

	it("adds the advice the shut view led with, on top of the model's text", () => {
		const computing = { ...base, timedOut: true, exitCode: null, durationMs: 60_000, timeoutSec: 60 };
		const open = expandedView(computing, identity, ROOMY).join("\n");
		assert.match(open, /Timed out after 60s and was killed/, "the model's sentence is still there");
		assert.match(open, /Raise the timeout if the work is legitimate/, "and so is the advice");

		const installing = { ...computing, codeStarted: false, declaredDeps: 2 };
		assert.match(expandedView(installing, identity, ROOMY).join("\n"), /Retry with timeout:180/);
	});

	it("wraps a long answer rather than handing the terminal a line too wide", () => {
		const lines = expandedView({ ...base, stdout: "z".repeat(NARROW * 2) }, identity, NARROW);
		for (const line of lines) assert.ok(line.length <= NARROW, `line too wide: ${line.length} chars: ${line}`);
		assert.equal(lines.filter(line => line.startsWith("z")).length, 2);
	});
});
