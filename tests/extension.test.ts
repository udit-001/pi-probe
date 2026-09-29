import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { render } from "../index.ts";

/** Load the extension and capture the tool it registers. */
async function loadTool(env: Record<string, string> = {}) {
	const saved = { ...env };
	for (const [k, v] of Object.entries(env)) process.env[k] = v;

	const mod = await import(`../index.ts?bust=${Math.random()}`);
	const captured = { tool: undefined as any, handlers: [] as any[] };
	const pi = {
		registerTool: (tool: any) => {
			captured.tool = tool;
		},
		on: (event: string, handler: any) => captured.handlers.push([event, handler]),
	};
	mod.default(pi as any);
	for (const [, handler] of captured.handlers) {
		if (typeof handler === "function") await handler({});
	}
	return {
		tool: captured.tool,
		restore: () => {
			for (const k of Object.keys(saved)) process.env[k] = saved[k];
		},
	};
}

const ctxFor = (over: Record<string, unknown> = {}) => ({
	mode: "interactive",
	hasUI: true,
	cwd: process.cwd(),
	signal: new AbortController().signal,
	ui: { confirm: async () => true, select: async () => null, input: async () => null, notify: async () => {} },
	...over,
});

describe("the probe tool as the model sees it", () => {
	it("is named with the leading word and registered once", async () => {
		const { tool } = await loadTool();
		assert.equal(tool.name, "probe");
		assert.equal(tool.label, "Python probe");
	});

	it("carries the inline dependency syntax, which a model cannot guess", async () => {
		const { tool } = await loadTool();
		// uv reads dependency metadata from this exact comment block. Without it
		// in the description, the model writes `import pandas` and gets
		// ModuleNotFoundError on every attempt.
		assert.match(tool.description, /# \/\/\/ script/);
		assert.match(tool.description, /# dependencies = \["pandas"\]/);
		assert.match(tool.description, /# \/\/\//);
	});

	it("tells the model to end with the expression it wants to see", async () => {
		const { tool } = await loadTool();
		assert.match(tool.description, /last expression/);
	});

	it("routes edits and real files away from itself", async () => {
		const { tool } = await loadTool();
		assert.match(tool.description, /For edits use edit/);
	});

	it("takes code and an optional timeout, nothing else", async () => {
		const { tool } = await loadTool();
		const props = Object.keys(tool.parameters.properties);
		assert.deepEqual(props.sort(), ["code", "timeout"]);
		assert.deepEqual(tool.parameters.required, ["code"]);
	});

	it("caps the timeout it will accept", async () => {
		const { tool } = await loadTool();
		assert.equal(tool.parameters.properties.timeout.minimum, 1);
		assert.equal(tool.parameters.properties.timeout.maximum, 600);
	});
});

describe("running a probe", () => {
	it("returns the answer as the text the model reads", async () => {
		const { tool } = await loadTool();
		const result = await tool.execute("t1", { code: "sum(range(10))\n" }, new AbortController().signal, () => {}, ctxFor());
		assert.match(result.content[0].text, /45/);
		assert.match(result.content[0].text, /^ok \(\d+ms\)/);
		assert.equal(result.details.exitCode, 0);
	});

	it("refuses empty code rather than running nothing", async () => {
		const { tool } = await loadTool();
		await assert.rejects(
			() => tool.execute("t2", { code: "   \n" }, new AbortController().signal, () => {}, ctxFor()),
			/needs some code/,
		);
	});

	it("shows the traceback and says what went wrong", async () => {
		const { tool } = await loadTool();
		const result = await tool.execute("t3", { code: "1/0\n" }, new AbortController().signal, () => {}, ctxFor());
		assert.match(result.content[0].text, /Exited 1/);
		assert.match(result.content[0].text, /ZeroDivisionError/);
	});

	it("asks before installing a package, and proceeds when approved", async () => {
		const { tool } = await loadTool();
		const asked: string[] = [];
		const ctx = ctxFor({
			ui: { ...ctxFor().ui, confirm: async (_t: string, msg: string) => (asked.push(msg), true) },
		});
		const result = await tool.execute(
			"t4",
			{ code: '# /// script\n# dependencies = ["rich"]\n# ///\nimport rich\n"ok"\n' },
			new AbortController().signal,
			() => {},
			ctx,
		);
		assert.equal(asked.length, 1);
		assert.match(asked[0] ?? "", /rich/);
		assert.match(result.content[0].text, /ok/);
	});

	it("stops when the human says no", async () => {
		const { tool } = await loadTool();
		const ctx = ctxFor({ ui: { ...ctxFor().ui, confirm: async () => false } });
		await assert.rejects(
			() =>
				tool.execute(
					"t5",
					{ code: '# /// script\n# dependencies = ["rich"]\n# ///\nimport rich\n' },
					new AbortController().signal,
					() => {},
					ctx,
				),
			/cancelled/,
		);
	});

	it("asks only once per session, not once per call", async () => {
		const { tool } = await loadTool();
		let asked = 0;
		const ctx = ctxFor({ ui: { ...ctxFor().ui, confirm: async () => (asked++, true) } });
		for (let i = 0; i < 3; i++) {
			await tool.execute(
				`t6-${i}`,
				{ code: '# /// script\n# dependencies = ["rich"]\n# ///\nimport rich\n"ok"\n' },
				new AbortController().signal,
				() => {},
				ctx,
			);
		}
		assert.equal(asked, 1);
	});

	it("fails closed when there is no UI to ask", async () => {
		const { tool } = await loadTool();
		const ctx = ctxFor({ hasUI: false });
		await assert.rejects(
			() =>
				tool.execute(
					"t7",
					{ code: '# /// script\n# dependencies = ["rich"]\n# ///\nimport rich\n' },
					new AbortController().signal,
					() => {},
					ctx,
				),
			/probe\.config\.json/,
		);
	});

	it("refuses a dependency given as a URL, even after approval", async () => {
		const { tool } = await loadTool();
		const asked: string[] = [];
		const ctx = ctxFor({ ui: { ...ctxFor().ui, confirm: async (_t: string, m: string) => (asked.push(m), true) } });
		await assert.rejects(
			() =>
				tool.execute(
					"t8",
					{ code: '# /// script\n# dependencies = ["evil @ https://example.com/evil.whl"]\n# ///\nimport evil\n' },
					new AbortController().signal,
					() => {},
					ctx,
				),
			/refuses dependencies given as a URL/,
		);
		assert.equal(asked.length, 0, "a URL must never reach the approval prompt");
	});

	it("reports a missing uv instead of failing quietly", async () => {
		const { tool } = await loadTool();
		// Save PATH here rather than via loadTool: it is this test that changes
		// it, and a shared PATH would break every later probe in the file.
		const savedPath = process.env.PATH;
		process.env.PATH = "/nonexistent";
		try {
			await assert.rejects(
				() => tool.execute("t9", { code: "1\n" }, new AbortController().signal, () => {}, ctxFor()),
				/not found on PATH/,
			);
		} finally {
			process.env.PATH = savedPath;
		}
	});
});

describe("configuration", () => {
	it("installs an allowed package without asking", async () => {
		// Deliberately not the `pi-probe-` prefix: the scratch-directory test
		// in probe.test.ts counts directories under that name.
		const dir = await mkdtemp(join(tmpdir(), "probe-cfg-"));
		const path = join(dir, "config.json");
		await writeFile(path, JSON.stringify({ allowedPackages: ["rich"] }));
		try {
			const { tool } = await loadTool({ PI_PROBE_CONFIG: path });

			let asked = 0;
			const ctx = ctxFor({ ui: { ...ctxFor().ui, confirm: async () => (asked++, true) } });
			const result = await tool.execute(
				"c1",
				{ code: '# /// script\n# dependencies = ["rich"]\n# ///\nimport rich\n"ok"\n' },
				new AbortController().signal,
				() => {},
				ctx,
			);
			assert.equal(asked, 0);
			assert.match(result.content[0].text, /ok/);
		} finally {
			await rm(dir, { recursive: true, force: true });
			delete process.env.PI_PROBE_CONFIG;
		}
	});

	it("ignores a config that is not valid JSON rather than breaking every probe", async () => {
		const dir = await mkdtemp(join(tmpdir(), "probe-cfg-"));
		const path = join(dir, "config.json");
		await writeFile(path, "{ this is not json");
		try {
			const { tool } = await loadTool({ PI_PROBE_CONFIG: path });
			const result = await tool.execute(
				"c2",
				{ code: "'still works'\n" },
				new AbortController().signal,
				() => {},
				ctxFor(),
			);
			assert.match(result.content[0].text, /still works/);
		} finally {
			await rm(dir, { recursive: true, force: true });
			delete process.env.PI_PROBE_CONFIG;
		}
	});
});

describe("explaining a timeout", () => {
	it("blames a long computation when there is output to show", async () => {
		const { tool } = await loadTool();
		const result = await tool.execute(
			"t10",
			{ code: 'import time\nprint("started", flush=True)\nwhile True:\n    time.sleep(1)\n', timeout: 2 },
			new AbortController().signal,
			() => {},
			ctxFor(),
		);
		assert.match(result.content[0].text, /Timed out after 2s/);
		assert.match(result.content[0].text, /Raise the timeout/);
		assert.doesNotMatch(result.content[0].text, /installing/);
	});

});

/**
 * The install-vs-compute branch is tested directly rather than through a real
 * install: a cold install takes seconds and a warm one takes milliseconds, so
 * an integration test here would be timing-dependent and would rot.
 */
describe("explaining a timeout, directly", () => {
	const base = {
		stdout: "",
		stderr: "",
		exitCode: null,
		timedOut: true,
		aborted: false,
		truncated: false,
		droppedEnv: [],
		durationMs: 2000,
		declaredDeps: 0,
		codeStarted: true,
		spawnError: undefined,
	};

	it("blames the installer when the code never started and packages were declared", () => {
		const text = render({ ...base, codeStarted: false, declaredDeps: 3 });
		assert.match(text, /before the code ran/);
		assert.match(text, /3 package\(s\) were declared/);
		assert.match(text, /installing them/);
		assert.doesNotMatch(text, /Raise the timeout/);
	});

	it("blames the computation when the code did start", () => {
		const text = render({ ...base, declaredDeps: 3 });
		assert.match(text, /Raise the timeout/);
		assert.doesNotMatch(text, /installing them/);
	});

	it("blames the computation when the code never started but nothing was declared", () => {
		// No packages means there is nothing to install, so the install branch
		// would be a lie.
		const text = render({ ...base, codeStarted: false });
		assert.match(text, /Raise the timeout/);
		assert.doesNotMatch(text, /installing them/);
	});

	it("does not claim the environment is secret", () => {
		const text = render({ ...base, droppedEnv: ["GITHUB_TOKEN"], timedOut: false, exitCode: 0 });
		assert.match(text, /environment does not carry those values/);
		assert.doesNotMatch(text, /cannot read your credentials/);
	});
});

/**
 * The collapsed line is what a human supervising a run actually reads. It used
 * to be the first line of `render`, which is always the status line, so every
 * probe looked like `ok (595ms)` with the answer hidden behind an expand.
 */
describe("the collapsed view a human reads", () => {
	const theme = { fg: (_color: string, text: string) => text };

	const collapsedLines = async (details: Record<string, unknown>) => {
		const { tool } = await loadTool();
		return tool.renderResult({ details }, { expanded: false }, theme).render() as string[];
	};

	const base = {
		stdout: "",
		stderr: "",
		exitCode: 0,
		timedOut: false,
		aborted: false,
		droppedEnv: ["GITHUB_TOKEN"],
		durationMs: 595,
		declaredDeps: 0,
		codeStarted: true,
		spawnError: undefined,
	};

	it("shows the value, not just the receipt", async () => {
		const lines = await collapsedLines({ ...base, stdout: "{'providers': 225}\n" });
		assert.deepEqual(lines, ["ok (595ms)", "  {'providers': 225}"]);
	});

	it("keeps the last lines, where a probe's answer lives", async () => {
		const stdout = Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
		const lines = await collapsedLines({ ...base, stdout });
		assert.deepEqual(lines, ["ok (595ms)", "... 5 earlier lines, expand for all", "  line6", "  line7", "  line8"]);
	});

	it("shows the traceback when the probe failed", async () => {
		const lines = await collapsedLines({ ...base, exitCode: 1, stderr: "ValueError: boom\n" });
		assert.deepEqual(lines, ["Exited 1 (595ms)", "  ValueError: boom"]);
	});

	it("does not let the environment note stand in for a missing answer", async () => {
		const lines = await collapsedLines(base);
		assert.deepEqual(lines, ["ok (595ms)"]);
	});

	it("keeps the two-sentence timeout advice on one line", async () => {
		const lines = await collapsedLines({ ...base, timedOut: true, codeStarted: false, declaredDeps: 2 });
		assert.equal(lines.length, 1);
		const only = lines[0] ?? "";
		assert.ok(only.length <= 80, `expected one short line, got ${only.length} chars`);
	});

	it("expands to the same text the model reads", async () => {
		const details = { ...base, stdout: "{'providers': 225}\n" };
		const { tool } = await loadTool();
		const expanded = tool.renderResult({ details }, { expanded: true }, theme).render().join("\n");
		assert.equal(expanded, render(details as any));
	});
});
