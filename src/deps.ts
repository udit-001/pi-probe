/**
 * Dependency policy.
 *
 * The invariant this module enforces:
 *
 *   A package *declared* in a probe's PEP 723 header does not reach the
 *   installer without a human having agreed to that name.
 *
 * The word "declared" is load-bearing and is not decorative. A cell runs as
 * the user, so it can shell out to `uv pip install` itself and never touch
 * this module. This is a gate on the declaration path, not a sandbox. The
 * honest framing is that it removes the easy, invisible channel -- the one a
 * model reaches by accident while trying to be helpful -- and does nothing
 * about a cell that goes looking for another way.
 *
 * The name is the whole attack surface. A poisoned README, a scraped issue or
 * a plain typo can all steer the model toward `python-dateutils` instead of
 * `python-dateutil`, and the difference between those two is somebody else's
 * code running as the user. Resolution-by-name cannot tell them apart, so the
 * decision happens before resolution, on the name alone.
 *
 * Direct references (a URL, a VCS location, a local path) are refused
 * unconditionally. There is nothing to allowlist about `pkg @ https://...` --
 * the bytes come from wherever the model said, so approving the name approves
 * nothing.
 *
 * And the block handed to uv is *rebuilt* from the parsed names, never passed
 * through. Passing it through would leave the model free to add
 * `[tool.uv] index = "https://evil.example"`, which redirects resolution while
 * the human is staring at a perfectly innocent package name. Rebuilding is the
 * same move as the environment: construct the trusted shape rather than filter
 * the untrusted one.
 */

/**
 * Anything that points resolution at bytes rather than a name on an index:
 * a URL, a VCS location, a relative or absolute path, a home-relative path,
 * or a wheel/sdist filename.
 */
const DIRECT_REFERENCE = /@|:\/\//i;

/** Relative, absolute, home-relative, or Windows-drive paths, and archives. */
const PATH_LIKE = /^\.{0,2}[/\\]|^[A-Za-z]:[\\/]|^~[/\\]|\.(?:whl|zip|tar\.gz|tar\.bz2)$/i;

/** The `# /// script` ... `# ///` block, per PEP 723. */
const SCRIPT_BLOCK = /^[ \t]*#[ \t]*\/\/\/[ \t]*script[ \t]*\r?$(?:\r?\n(?:[ \t]*#.*)?)*?^[ \t]*#[ \t]*\/\/\/[ \t]*\r?$/m;

/** PEP 503 normalisation, so `Rich`, `rich` and `rich_thing` compare sanely. */
export function normalizePackageName(name: string): string {
	return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

/** Pull the PEP 723 block out of source, or return null when there is none. */
export function extractScriptMetadata(code: string): string | null {
	const match = code.match(SCRIPT_BLOCK);
	return match ? match[0].replace(/\r/g, "").trimEnd() : null;
}

/** Cut a trailing `# comment`, ignoring a `#` inside a quoted string. */
function stripInlineComment(line: string): string {
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (quote) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "#") return line.slice(0, i);
	}
	return line;
}

/** Strip the `#` that makes each line of a PEP 723 block a comment. */
function uncomment(block: string): string {
	return block
		.split(/\r?\n/)
		.map((line) => stripInlineComment(line.replace(/^[ \t]*#[ \t]?/, "")))
		.join("\n");
}

/** Split on commas that are not inside a quoted string, then unquote. */
function splitEntries(body: string): string[] {
	const items: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (const char of body) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === ",") {
			if (current.trim()) items.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) items.push(current.trim());
	return items;
}

/** Read one `key = [...]` list out of a PEP 723 block, comments and all. */
function readList(block: string, key: string): string[] {
	// The closing `]` must end its line. Without that anchor the lazy match
	// stops inside `uvicorn[standard]` and returns a truncated list.
	const match = block.match(
		new RegExp(`^[ \\t]*#[ \\t]*${key}[ \\t]*=[ \\t]*\\[(.*?)\\][ \\t]*$`, "ms"),
	);
	if (!match) return [];
	return splitEntries(uncomment(match[1] as string));
}

/** Read a scalar `key = "value"` out of a PEP 723 block. */
function readScalar(block: string, key: string): string | undefined {
	const match = block.match(new RegExp(`^[ \\t]*#[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, "m"));
	if (!match) return undefined;
	const value = (match[1] as string).trim();
	const unquoted = value.replace(/^["']|["']$/g, "");
	return unquoted || undefined;
}

export interface DeclaredDependency {
	/** The raw entry exactly as written. */
	raw: string;
	/** The installable name, normalised. Empty when the entry is a direct reference. */
	name: string;
	/** True when the entry names a URL, a VCS location, or a local path. */
	direct: boolean;
}

/** Every dependency the source asks for, in the order written. */
export function readDeclaredDeps(code: string): DeclaredDependency[] {
	const block = extractScriptMetadata(code);
	if (!block) return [];
	return readList(block, "dependencies").map((raw) => {
		const trimmed = raw.trim();
		const direct = DIRECT_REFERENCE.test(trimmed) || PATH_LIKE.test(trimmed);
		// The name is everything before the first version, marker or separator.
		const name = direct ? "" : normalizePackageName(trimmed.split(/[\s;<>=!~[(@]/)[0] ?? "");
		return { raw: trimmed, name, direct };
	});
}

/**
 * Rebuild the PEP 723 block that will actually reach uv.
 *
 * Rebuilt rather than forwarded on purpose. Forwarding would let model code
 * attach a `[tool.uv]` table -- `index`, `extra-index`, `constraint-dependencies`
 * -- that redirects resolution away from PyPI while the human reads and
 * approves an ordinary-looking package name. Rebuilding from the entries that
 * survived the policy means the block and the approval are the same thing.
 */
export function buildMetadataBlock(
	deps: readonly DeclaredDependency[],
	requiresPython?: string,
): string {
	const lines = ["# /// script"];
	lines.push(`# dependencies = [${deps.map((d) => JSON.stringify(d.raw)).join(", ")}]`);
	if (requiresPython) lines.push(`# requires-python = ${JSON.stringify(requiresPython)}`);
	lines.push("# ///");
	return lines.join("\n");
}

/** The `requires-python` a cell asked for, if any. */
export function readRequiresPython(code: string): string | undefined {
	const block = extractScriptMetadata(code);
	return block ? readScalar(block, "requires-python") : undefined;
}

export interface DepsConfig {
	/** Package names a human has blessed in probe.config.json. */
	allowedPackages: readonly string[];
}

export interface DepsDecision {
	/** Cleared to install. */
	approved: string[];
	/** Names needing a one-time human yes. */
	needsApproval: string[];
	/** Raw entries refused outright: URL, VCS or path references. */
	refused: string[];
	/** Normalised names on `needsApproval`, for a per-session memo. */
	pendingKeys: string[];
}

/**
 * Split declared dependencies into what may run now, what needs a human, and
 * what is never allowed. `approvedBy` is the set already agreed this session.
 */
export function authorizeDeps(
	deps: readonly DeclaredDependency[],
	config: DepsConfig,
	approvedBy: ReadonlySet<string> = new Set(),
): DepsDecision {
	const blessed = new Set(config.allowedPackages.map(normalizePackageName));
	const approved: string[] = [];
	const needsApproval: string[] = [];
	const pendingKeys: string[] = [];
	const refused: string[] = [];

	for (const dep of deps) {
		if (dep.direct) {
			refused.push(dep.raw);
			continue;
		}
		if (blessed.has(dep.name) || approvedBy.has(dep.name)) {
			approved.push(dep.raw);
			continue;
		}
		needsApproval.push(dep.raw);
		if (!pendingKeys.includes(dep.name)) pendingKeys.push(dep.name);
	}

	return { approved, needsApproval, refused, pendingKeys };
}
