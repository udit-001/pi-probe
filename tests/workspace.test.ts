import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PARENT_NAME, resolveWorkspace } from "../src/workspace.ts";

const freshBase = () => mkdtemp(join(tmpdir(), "pi-probe-test-"));

describe("resolveWorkspace", () => {
	it("is deterministic per identity and distinct across identities", async () => {
		const base = await freshBase();
		try {
			const a = await resolveWorkspace("sess-1", base);
			const a2 = await resolveWorkspace("sess-1", base);
			const b = await resolveWorkspace("sess-2", base);
			assert.equal(a, a2); // same session, same verified directory
			assert.notEqual(a, b); // different session, never shared
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("creates a private directory owned by us", async () => {
		const base = await freshBase();
		try {
			const ws = await resolveWorkspace("my-session", base);
			const st = await lstat(ws);
			assert.equal(st.isDirectory(), true);
			assert.equal(st.isSymbolicLink(), false);
			assert.equal(st.mode & 0o777, 0o700);
			if (typeof process.getuid === "function") {
				assert.equal(st.uid, process.getuid());
			}
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("sanitizes a hostile identity so the path cannot escape the parent", async () => {
		const base = await freshBase();
		try {
			const ws = await resolveWorkspace("../../evil-session", base);
			assert.ok(join(base, PARENT_NAME) === ws || ws.startsWith(join(base, PARENT_NAME) + "/"));
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("refuses a planted parent and stays out of it entirely", async () => {
		const base = await freshBase();
		try {
			const plantedParent = join(base, PARENT_NAME);
			await symlink("/tmp", plantedParent);
			const ws = await resolveWorkspace("any-session", base);
			assert.notEqual(ws, join(plantedParent, "any-session"));
			assert.ok(!ws.startsWith(plantedParent + "/")); // nothing under the planted parent
			assert.equal((await lstat(plantedParent)).isSymbolicLink(), true);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("refuses a pre-planted symlink and falls back to a fresh random directory", async () => {
		const base = await freshBase();
		try {
			const parent = join(base, PARENT_NAME);
			await mkdir(parent, { recursive: true });
			const planted = join(parent, "planted-session");
			await symlink("/tmp", planted);
			const ws = await resolveWorkspace("planted-session", base);
			assert.notEqual(ws, planted); // never reuse the planted path
			const st = await lstat(ws);
			assert.equal(st.isDirectory(), true);
			assert.equal(st.isSymbolicLink(), false);
			// the attacker's symlink is untouched
			assert.equal((await lstat(planted)).isSymbolicLink(), true);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("refuses a directory we do not own privately and falls back", async () => {
		const base = await freshBase();
		try {
			const parent = join(base, PARENT_NAME);
			await mkdir(parent, { recursive: true });
			// planted as a world-open directory (e.g. attacker-created 0777)
			const planted = join(parent, "open-session");
			await mkdir(planted, { recursive: true, mode: 0o777 });
			const ws = await resolveWorkspace("open-session", base);
			assert.notEqual(ws, planted);
			assert.equal((await lstat(ws)).isDirectory(), true);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("returns a fresh random directory when there is no identity", async () => {
		const base = await freshBase();
		try {
			const a = await resolveWorkspace(undefined, base);
			const b = await resolveWorkspace("", base);
			assert.notEqual(a, b); // no identity, never deterministic
			assert.equal((await lstat(a)).isDirectory(), true);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("prunes stale sibling workspaces but keeps recent and its own", async () => {
		const base = await freshBase();
		try {
			const parent = join(base, PARENT_NAME);
			await mkdir(parent, { recursive: true, mode: 0o700 });
			const old = join(parent, "old-session");
			const recent = join(parent, "recent-session");
			await mkdir(old, { mode: 0o700 });
			await mkdir(recent, { mode: 0o700 });
			const oldTime = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
			await utimes(old, oldTime, oldTime);

			const ws = await resolveWorkspace("mine", base);
			// own workspace survives, old sibling gone, recent sibling stays
			const own = await lstat(ws).catch(() => null);
			assert.ok(own?.isDirectory());
			await assert.rejects(lstat(old));
			assert.equal((await lstat(recent)).isDirectory(), true);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});