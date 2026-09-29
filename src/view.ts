/**
 * view -- one probe outcome, four renderings of it.
 *
 * A probe has three readers and they do not want the same thing. The model
 * reads prose and needs the whole transcript. A human supervising a run reads
 * a scan and needs the value, not the receipt. A human who expanded the call
 * reads carefully and needs the same text with the shape pulled apart. Every
 * one of those renderings decides the same things -- what state this run ended
 * in, what to call it, how long it took, whether the output was cut, whether
 * there is advice to give -- and every one of those decisions used to be made
 * twice, in two shapes, which is how the TUI and the model text drifted apart.
 *
 * So the decisions live here, once, and the four renderings are thin reads of
 * them. The interface is four functions and one port; behind it sit the state
 * classification, the duration format, the label vocabulary, the trailing
 * newline trim, the stderr-over-stdout preference, and the timeout advice.
 *
 * This module is pure. It reads no clock, no environment, and no global
 * state, and the one thing it cannot compute for itself -- the key that
 * expands a tool result -- arrives through {@link ViewTheme.expandHint}
 * instead of an import. pi's own `keyHint` reads process-global theme and
 * keybinding state and throws outside a live TUI; keeping it at the call site
 * is what lets these renderings be tested in a bare process.
 */

import { MAX_OUTPUT_BYTES, MAX_TIMEOUT_SEC, type ProbeOutcome } from "./probe.ts";

/** How many lines of output the shut view shows. The tail, because that is the answer. */
const COLLAPSED_TAIL_LINES = 3;

/** How much of the code the call line quotes. A call line is a receipt, not a listing. */
const CALL_SUMMARY_CHARS = 60;

/** How long the recovery hint sleeps before giving up on a round number. */
const SUGGESTED_TIMEOUT_MULTIPLE = 3;
const SUGGESTED_TIMEOUT_ROUNDING_SEC = 30;

/** The theme tokens these views use. A subset of pi's, named so a typo is a type error. */
export type ViewColor = "accent" | "dim" | "error" | "muted" | "success" | "toolOutput" | "toolTitle" | "warning";

/**
 * The styling port. Two adapters satisfy it: pi's live theme, and the identity
 * theme the tests use to assert on plain text.
 */
export interface ViewTheme {
	fg(color: ViewColor, text: string): string;
	bold(text: string): string;
	/** How to tell the reader the result can be opened, e.g. "Ctrl+O to expand". */
	expandHint: string;
}

/** How a run ended. One name per state, so a scan can match on the word. */
type RunState = "ok" | "failed" | "timedOut" | "aborted";

/**
 * A piece of advice for a human, and whether it is a diagnosis or an action.
 *
 * A diagnosis is bracketed, an action is not, because a diagnosis is a label
 * on the run and an action is an instruction to the reader. Mixing them makes
 * the run harder to scan, not easier.
 */
interface Advisory {
	text: string;
	kind: "diagnosis" | "action";
}

/**
 * The one decomposition of an outcome. Internal seam: every rendering is built
 * from this, and no caller needs it, so it is not exported.
 *
 * `label` and `sentence` are the same fact in two registers. The label is what
 * a scanning eye matches on; the sentence is what the model reads. Keeping
 * both here is what stops the collapsed line and the model text from calling
 * one outcome two different things.
 */
interface RunSummary {
	state: RunState;
	/** Short and fixed-shape: "ok", "Exited 1", "timed out", "cancelled". */
	label: string;
	/** A full sentence, for a reader who reads rather than scans. */
	sentence: string;
	color: ViewColor;
	/** The receipt. Last in every view, because it is the least important fact. */
	duration: string;
	stdout: string;
	stderr: string;
	note: string;
	advisories: Advisory[];
}

function classify(outcome: ProbeOutcome): RunState {
	if (outcome.timedOut) return "timedOut";
	if (outcome.aborted) return "aborted";
	return outcome.exitCode === 0 ? "ok" : "failed";
}

const STATE_COLOR: Record<RunState, ViewColor> = {
	ok: "success",
	failed: "error",
	timedOut: "warning",
	aborted: "warning",
};

/**
 * Elapsed time, in the units a human reads at a glance: tenths under a minute,
 * then whole minutes, then hours. "12043ms" is a receipt nobody parses.
 */
function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const total = Math.floor(seconds);
	if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
	return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

/**
 * The timeout worth retrying with: three times the one that just ran, rounded
 * up to something a human would type, and never more than the ceiling accepts.
 * Capped and floored, because a suggestion outside the accepted range is
 * advice the reader cannot follow.
 */
function suggestTimeout(timeoutSec: number): number {
	const want = Math.ceil((timeoutSec * SUGGESTED_TIMEOUT_MULTIPLE) / SUGGESTED_TIMEOUT_ROUNDING_SEC) * SUGGESTED_TIMEOUT_ROUNDING_SEC;
	return Math.min(MAX_TIMEOUT_SEC, Math.max(want, timeoutSec + SUGGESTED_TIMEOUT_ROUNDING_SEC));
}

/**
 * What to do about a timeout, in one line the reader can act on.
 *
 * At the ceiling there is no larger timeout to ask for, and suggesting the
 * number that just failed is worse than saying nothing -- so the advice
 * changes rather than repeating the input.
 */
function recovery(outcome: ProbeOutcome, installing: boolean): string {
	if (!installing) return "Raise the timeout if the work is legitimate, or narrow the code";
	const next = suggestTimeout(outcome.timeoutSec);
	if (next <= outcome.timeoutSec) return `Already at the ${MAX_TIMEOUT_SEC}s ceiling — split the work or drop the packages`;
	return `Retry with timeout:${next} — the install is cached`;
}

/**
 * Collapse a run to whitespace and clip it, so a long line cannot take over
 * the view. A hard character cap rather than a column one: these renderings
 * hand pi a fixed array of strings and never learn the terminal width, which
 * is the price of not importing pi's TUI package.
 */
function snippet(text: string, max: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

/** True when the run spent its budget on uv rather than on the cell. */
function spentInstalling(outcome: ProbeOutcome): boolean {
	return !outcome.codeStarted && outcome.declaredDeps > 0;
}

function summarize(outcome: ProbeOutcome): RunSummary {
	const state = classify(outcome);
	const installing = spentInstalling(outcome);

	let label: string;
	let sentence: string;
	if (state === "ok") {
		label = "ok";
		sentence = `ok (${outcome.durationMs}ms)`;
	} else if (state === "failed") {
		label = `Exited ${outcome.exitCode}`;
		sentence = `${label} (${outcome.durationMs}ms)`;
	} else if (state === "aborted") {
		label = "cancelled";
		sentence = "Cancelled before it finished.";
	} else if (installing) {
		label = "timed out";
		sentence =
			`Timed out after ${Math.round(outcome.durationMs / 1000)}s before the code ran. ` +
			`${outcome.declaredDeps} package(s) were declared, so the budget went to ` +
			"installing them. Retry with a higher timeout; the install is cached, so the " +
			"retry gets the whole budget for the code.";
	} else {
		label = "timed out";
		sentence =
			`Timed out after ${Math.round(outcome.durationMs / 1000)}s and was killed. ` +
			"Raise the timeout if the work is legitimate, or narrow the code.";
	}

	const advisories: Advisory[] = [];
	if (state === "timedOut") {
		// Each on its own line, and neither capped. This is the one place the
		// shut view used to destroy the only advice it had: a status line with
		// two sentences in it is a status line that gets clipped, and the
		// reader who most needs the recovery is the one who loses it.
		advisories.push({
			kind: "diagnosis",
			text: installing
				? `timed out after ${formatDuration(outcome.durationMs)} installing ${outcome.declaredDeps} package(s) — the code never ran`
				: `timed out after ${formatDuration(outcome.durationMs)} and was killed`,
		});
		advisories.push({
			kind: "action",
			text: recovery(outcome, installing),
		});
	} else if (state === "aborted") {
		// The reader did this. Advice would be noise.
		advisories.push({ kind: "diagnosis", text: "cancelled before it finished" });
	}
	if (outcome.truncated) {
		advisories.push({
			kind: "diagnosis",
			text: `Truncated: output passed the ${Math.round(MAX_OUTPUT_BYTES / 1000)}KB capture limit, so this is only the head and the tail`,
		});
	}

	return {
		state,
		label,
		sentence,
		color: STATE_COLOR[state],
		duration: formatDuration(outcome.durationMs),
		stdout: outcome.stdout.replace(/\n$/, ""),
		// uv writes install and resolution progress here, so it is only worth
		// showing when something actually went wrong or needs installing.
		stderr: outcome.stderr.trim() ? outcome.stderr.replace(/\n$/, "") : "",
		note:
			outcome.droppedEnv.length > 0
				? // Scoped claim on purpose. The environment is built from a fixed
					// list, so a probe cannot read these -- but it runs as you and can
					// still open a file under your home directory, which is a different
					// thing entirely.
					`Note: probe did not pass through ${outcome.droppedEnv.join(", ")}, so its ` +
					"environment does not carry those values."
				: "",
		advisories,
	};
}

function renderAdvisories(advisories: Advisory[], theme: ViewTheme): string[] {
	return advisories.map(advisory =>
		theme.fg("warning", advisory.kind === "action" ? `  ${advisory.text}` : `  [${advisory.text}]`),
	);
}

/**
 * The call line: what was asked, before anything has run.
 *
 * The expression that will produce the value is the last meaningful line of
 * the cell, because that is the contract the tool asks the model to follow --
 * end with the thing you want to see. Leading with the imports would quote
 * the setup; leading with the dependency header would quote nothing at all.
 */
export function callView(args: { code: string; timeout?: number }, theme: ViewTheme): string {
	const summaryLine = args.code
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith("#"))
		.pop();

	let text = theme.fg("toolTitle", theme.bold("probe"));
	text += theme.fg("toolOutput", `  ${summaryLine ? snippet(summaryLine, CALL_SUMMARY_CHARS) : "…"}`);
	if (args.timeout !== undefined) text += theme.fg("muted", ` (timeout ${args.timeout}s)`);
	return text;
}

/** The rendering the model reads: prose, whole, labelled. */
export function textView(outcome: ProbeOutcome): string {
	const { sentence, stdout, stderr, note, advisories } = summarize(outcome);
	return [
		sentence,
		stdout,
		stderr && `stderr:\n${stderr}`,
		note,
		// Only the fact the model cannot infer from the text it is looking at:
		// that a gap in the middle is ours, not the cell's.
		...advisories.filter(a => a.text.startsWith("Truncated:")).map(a => `Note: ${a.text}.`),
	]
		.filter(Boolean)
		.join("\n\n");
}

/**
 * The shut view a human scans: the tail of the answer, then any advice, then
 * the receipt.
 *
 * The receipt is last, and that is the whole change. Leading with it made
 * every probe look like `ok (595ms)` with the answer hiding behind an expand,
 * and leading with a status sentence made every probe a different length.
 */
export function collapsedView(outcome: ProbeOutcome, theme: ViewTheme): string[] {
	const summary = summarize(outcome);
	const out: string[] = [""];

	const body = summary.stderr || summary.stdout;
	if (body) {
		const all = body.split("\n");
		const tail = all.slice(-COLLAPSED_TAIL_LINES);
		// stderr outranks stdout: a failing probe usually prints the traceback
		// and nothing else, and that traceback is the whole diagnosis. It is
		// also the one place these views step away from pi's house style, which
		// tints all command output alike -- a traceback is a diagnosis, and a
		// diagnosis is worth telling apart from an answer.
		const color: ViewColor = summary.stderr ? "error" : "toolOutput";
		if (all.length > tail.length) {
			out.push(theme.fg("muted", `  ... ${all.length - tail.length} earlier lines, ${theme.expandHint}`));
		}
		for (const line of tail) out.push(theme.fg(color, `  ${line}`));
	}

	out.push(...renderAdvisories(summary.advisories, theme));
	out.push(theme.fg(summary.color, summary.label) + theme.fg("muted", ` · ${summary.duration}`));
	return out;
}

/**
 * The open view: the model's text, pulled apart and tinted, plus the advice a
 * scanning reader skipped over.
 *
 * The words are the model's words. Only the colour differs, so under an
 * identity theme the two are the same string, and a reader who expands gets
 * nothing new to re-read -- just the shape back.
 */
export function expandedView(outcome: ProbeOutcome, theme: ViewTheme): string[] {
	const { sentence, color, stdout, stderr, note, advisories } = summarize(outcome);
	const blocks = [
		theme.fg(color, sentence),
		theme.fg("toolOutput", stdout),
		stderr && `${theme.fg("muted", "stderr:")}\n${theme.fg("error", stderr)}`,
		theme.fg("dim", note),
	];
	return [...blocks.filter(Boolean).join("\n\n").split("\n"), ...renderAdvisories(advisories, theme)];
}
