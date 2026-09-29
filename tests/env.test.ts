import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChildEnv } from "../src/env.ts";

const parent = {
	PATH: "/usr/bin",
	HOME: "/home/ud",
	LANG: "en_US.UTF-8",
	OPENAI_API_KEY: "sk-secret",
	GITHUB_TOKEN: "ghp_secret",
	AWS_SECRET_ACCESS_KEY: "aws",
	DB_PASSWORD: "hunter2",
	SESSION_ID: "abc",
	MY_CREDENTIAL: "c",
	HTTP_PROXY: "http://proxy:8080",
	UV_CACHE_DIR: "/cache",
	EDITOR: "vim",
	PS1: "$ ",
} as Record<string, string>;

describe("buildChildEnv", () => {
	it("carries only the passthrough names", () => {
		const { env } = buildChildEnv(parent);
		assert.deepEqual(Object.keys(env).sort(), [
			"HOME",
			"HTTP_PROXY",
			"LANG",
			"PATH",
			"UV_CACHE_DIR",
		]);
	});

	it("never leaks a secret-shaped variable", () => {
		const { env } = buildChildEnv(parent);
		const serialised = JSON.stringify(env);
		for (const leak of ["sk-secret", "ghp_secret", "hunter2", "aws"]) {
			assert.ok(!serialised.includes(leak), `leaked ${leak}`);
		}
	});

	it("reports only what was actually asked for and refused", () => {
		const { dropped } = buildChildEnv(parent, { extraEnv: ["EDITOR", "OPENAI_API_KEY"] });
		assert.deepEqual(dropped, ["OPENAI_API_KEY"]);
	});

	it("stays quiet about secrets nobody asked for", () => {
		const { dropped } = buildChildEnv(parent);
		assert.deepEqual(dropped, []);
	});

	it("passes through non-secret infrastructure", () => {
		const { env } = buildChildEnv(parent);
		assert.equal(env.UV_CACHE_DIR, "/cache");
		assert.equal(env.HTTP_PROXY, "http://proxy:8080");
	});

	it("drops unrelated variables the child has no business seeing", () => {
		const { env } = buildChildEnv(parent);
		assert.equal(env.EDITOR, undefined);
		assert.equal(env.PS1, undefined);
	});

	it("refuses a secret even when a human explicitly asked for it", () => {
		const { env, dropped } = buildChildEnv(parent, { extraEnv: ["OPENAI_API_KEY"] });
		assert.equal(env.OPENAI_API_KEY, undefined);
		assert.ok(dropped.includes("OPENAI_API_KEY"));
	});

	it("honours a human-declared non-secret variable", () => {
		const { env } = buildChildEnv(parent, { extraEnv: ["EDITOR"] });
		assert.equal(env.EDITOR, "vim");
	});

	it("strips credentials embedded in a proxy URL", () => {
		const { env, dropped } = buildChildEnv({
			...parent,
			HTTP_PROXY: "http://alice:hunter2@proxy:8080",
		});
		assert.equal(env.HTTP_PROXY, undefined);
		assert.ok(dropped.includes("HTTP_PROXY"));
	});

	it("lets a forced value override anything else", () => {
		const { env } = buildChildEnv(parent, {
			forced: { PYTHONUNBUFFERED: "1", LANG: "C" },
		});
		assert.equal(env.PYTHONUNBUFFERED, "1");
		assert.equal(env.LANG, "C");
	});

	it("matches names case-insensitively on Windows", () => {
		const { env } = buildChildEnv({ Path: "C:\\bin", SystemRoot: "C:\\Windows" }, {
			caseInsensitive: true,
		});
		assert.equal(env.Path, "C:\\bin");
		assert.equal(env.SystemRoot, "C:\\Windows");
	});

	it("leaves the parent env untouched", () => {
		const snapshot = { ...parent };
		buildChildEnv(parent, { extraEnv: ["EDITOR"] });
		assert.deepEqual(parent, snapshot);
	});
});
