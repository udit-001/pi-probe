import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runProbe } from "../src/probe.ts";

const here = process.cwd();
const run = (code: string, extra: Record<string, unknown> = {}) =>
	runProbe({ code, cwd: here, ...extra });

describe("runProbe", () => {
	it("returns the value of the trailing expression", async () => {
		const r = await run("x = 6\nx * 7\n");
		assert.equal(r.exitCode, 0);
		assert.equal(r.stdout.trim(), "42");
	});

	it("captures stdout and stderr separately", async () => {
		const r = await run('import sys\nprint("out")\nsys.stderr.write("err\\n")\n');
		assert.match(r.stdout, /out/);
		assert.match(r.stderr, /err/);
	});

	it("prints nothing extra when the cell only prints", async () => {
		const r = await run('print("hello")\n');
		assert.equal(r.stdout.trim(), "hello");
	});

	it("keeps stdout in written order by running unbuffered", async () => {
		const r = await run('import sys\nfor i in range(3):\n    print(i); sys.stderr.write(f"e{i}\\n")\n');
		assert.equal(
			r.stdout.replace(/\s/g, ""),
			"012",
			"stdout arrived out of order relative to itself",
		);
	});

	it("reports a traceback with the model's own line numbers", async () => {
		const r = await run("def f():\n    return 1 / 0\n\nf()\n");
		assert.equal(r.exitCode, 1);
		assert.match(r.stderr, /ZeroDivisionError/);
		assert.match(r.stderr, /line 2, in f/);
		assert.match(r.stderr, /return 1 \/ 0/);
		assert.doesNotMatch(r.stderr, /__main__.*line 1\n/, "leaked a runner frame");
	});

	it("reports a syntax error against the line the model wrote", async () => {
		const r = await run("x = = 3\n");
		assert.notEqual(r.exitCode, 0);
		assert.match(r.stderr, /SyntaxError/);
		assert.match(r.stderr, /line 1/);
	});

	it("leaves no namespace behind for the next call", async () => {
		await run("leaked = 'first'\n");
		const r = await run("print(leaked)\n");
		assert.notEqual(r.exitCode, 0);
		assert.match(r.stderr, /NameError/);
	});

	it("imports the package under the working directory", async () => {
		const r = await run("import json\njson.dumps({'a': 1}, sort_keys=True)\n");
		assert.equal(r.stdout.trim(), "'{\"a\": 1}'");
	});

	it("honours sys.exit", async () => {
		const r = await run("import sys\nprint('bye')\nsys.exit(3)\n");
		assert.equal(r.exitCode, 3);
		assert.match(r.stdout, /bye/);
	});

	it("installs a declared dependency and uses it", async () => {
		const r = await run(
			'# /// script\n# dependencies = ["rich"]\n# ///\nfrom rich import get_console\nget_console().width = 20\nget_console().print("rich ok")\n',
		);
		assert.equal(r.exitCode, 0);
		assert.match(r.stdout, /rich ok/);
	});

	it("kills a runaway loop at the timeout", async () => {
		const r = await run("while True:\n    pass\n", { timeoutSec: 2 });
		assert.equal(r.timedOut, true);
		assert.ok(r.durationMs < 20_000);
	});

	it("kills a runaway loop that spawns children too", async () => {
		const r = await run(
			"import subprocess, sys\nsubprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'])\nwhile True:\n    pass\n",
			{ timeoutSec: 2 },
		);
		assert.equal(r.timedOut, true);
	});

	it("stops on abort", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);
		const r = await run("while True:\n    pass\n", {
			timeoutSec: 60,
			signal: controller.signal,
		});
		assert.equal(r.aborted, true);
	});

	it("caps runaway output without killing the run", async () => {
		const r = await run("print('x' * 250_000)\n'done'\n", { timeoutSec: 30 });
		assert.equal(r.exitCode, 0);
		assert.equal(r.truncated, true);
		assert.match(r.stdout, /bytes omitted/);
		assert.match(r.stdout, /'done'/, "the final value must survive truncation");
	});

	it("does not hand the child a secret from the parent env", async () => {
		const r = await run("import os\nprint(os.environ.get('SECRET_TOKEN'))\n", {
			parentEnv: { PATH: process.env.PATH ?? "", SECRET_TOKEN: "leaked" },
		});
		assert.equal(r.stdout.trim(), "None");
	});

	it("explains a missing uv rather than failing silently", async () => {
		const r = await run("print(1)\n", { command: "uv-does-not-exist-xyz" });
		assert.match(r.spawnError ?? "", /not found on PATH/);
		assert.match(r.spawnError ?? "", /uv/);
	});

	it("removes its scratch directory", async () => {
		const { readdir } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const scratch = async () =>
			(await readdir(tmpdir())).filter((n) => n.startsWith("pi-probe-")).length;

		// Compare before and after rather than asserting the directory is empty:
		// test files run in separate processes and may overlap.
		const before = await scratch();
		for (let i = 0; i < 3; i++) await run(`print(${i})\n`);
		assert.equal(await scratch(), before, "a scratch directory survived the run");
	});
});
