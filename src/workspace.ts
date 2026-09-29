/**
 * Workspace resolution for the probe tool.
 *
 * The workspace is the one thing that outlives a probe: a scratch directory
 * keyed by the pi session id, so a resumed conversation finds the data an
 * earlier run of the same session left behind (until the OS cleans the temp
 * dir). It is resolved lazily at tool invocation, never at plugin load.
 *
 * A deterministic path in a shared temp dir is an attack surface: another
 * local user could pre-create it as a symlink, so a routine probe write or
 * read would land in a directory the user never meant to touch. Resolution
 * is paranoid by construction:
 *
 *  - parent and workspace are created with non-recursive mkdir, so something
 *    already there is a refusal, not a silent adoption;
 *  - anything that exists must pass lstat: a real directory (a symlink is
 *    rejected), owned by us, mode 0700;
 *  - any failure falls back to a fresh random mkdtemp -- never reuse a path
 *    we did not create and verify ourselves.
 *
 * Re-validating on every invocation keeps a stray `chmod` from re-opening the
 * hole between calls, and creating a workspace triggers a prune of stale
 * siblings so the temp dir does not accumulate without bound.
 */

import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The parent directory name inside the OS temp dir. */
export const PARENT_NAME = "pi-probe";
/** How long an untouched workspace may outlive its session before prune removes it. */
export const STALE_MS = 14 * 24 * 60 * 60 * 1000;
/** The only mode a workspace we reuse may have: private to its owner. */
const OWNER_MODE = 0o700;

const myUid = typeof process.getuid === "function" ? process.getuid() : undefined;

/** A session id is a UUID; custom ids get sanitized so a path can never escape. */
function sanitizeIdentity(identity: string): string {
	return identity
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

/**
 * Make sure `path` is a directory we own with mode 0700, creating it when it
 * does not exist. Returns false when anything is already there that does not
 * pass the checks -- the caller must not use that path.
 */
async function ensureOwnedDir(path: string): Promise<boolean> {
	try {
		await mkdir(path, { mode: OWNER_MODE });
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
	}
	// It exists. Trust it only if it is a plain directory, ours, private.
	try {
		const st = await lstat(path);
		if (!st.isDirectory()) return false; // includes symlinks and files
		if (myUid !== undefined && st.uid !== myUid) return false;
		if ((st.mode & 0o777) !== OWNER_MODE) return false;
		return true;
	} catch {
		return false;
	}
}

/**
 * Delete workspace siblings under `parent` that are ours, older than
 * `STALE_MS`, and not `keep`. Best effort: a failure to read or remove an
 * entry is ignored rather than allowed to block the probe.
 */
async function pruneStale(parent: string, keep: string): Promise<void> {
	const now = Date.now();
	let entries: string[];
	try {
		entries = await readdir(parent);
	} catch {
		return;
	}
	for (const name of entries) {
		const entry = join(parent, name);
		if (entry === keep) continue;
		let st: Awaited<ReturnType<typeof lstat>>;
		try {
			st = await lstat(entry);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		if (myUid !== undefined && st.uid !== myUid) continue;
		if (now - st.mtimeMs < STALE_MS) continue;
		await rm(entry, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Resolve the workspace for a session identity.
 *
 * Same identity, same verified directory -- that is what lets a resumed
 * session keep its data. A missing or empty identity (headless/print modes)
 * gets a fresh random directory, and any path we could not create and verify
 * ourselves gets a random fallback: the safe failure is a new directory, not
 * a reused one.
 *
 * `base` is the temp root, injected in tests.
 */
export async function resolveWorkspace(identity: string | undefined, base: string = tmpdir()): Promise<string> {
	const parent = join(base, PARENT_NAME);
	if (!(await ensureOwnedDir(parent))) {
		// The parent itself is planted or unusable -- stay out of it entirely.
		return mkdtemp(join(base, `${PARENT_NAME}-`));
	}

	const slug = identity?.trim() ? sanitizeIdentity(identity) : "";
	if (!slug) {
		// No stable identity to key on; the workspace is ephemeral this run.
		await pruneStale(parent, "");
		return mkdtemp(join(parent, "anon-"));
	}

	const dir = join(parent, slug);
	if (await ensureOwnedDir(dir)) {
		await pruneStale(parent, dir);
		return dir;
	}
	await pruneStale(parent, "");
	return mkdtemp(join(parent, "fallback-"));
}