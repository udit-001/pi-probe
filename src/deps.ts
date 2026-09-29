/**
 * Dependency policy.
 *
 * The invariant this module enforces:
 *
 *   A package named in model-authored code does not reach the installer
 *   without a human having agreed to that name.
 *
 * The name is the whole attack surface. A poisoned README, a scraped issue or
 * a plain typo can all steer the model toward `python-dateutils` instead of
 * `python-dateutil`, and the difference between those two is somebody else's
 * code running as the user. Resolution-by-name cannot tell them apart, so the
 * decision happens before resolution, on the name alone.
 *
 * Direct references (a URL or a VCS location) are refused unconditionally.
 * There is nothing to allowlist about `pkg @ https://...` -- the bytes come
 * from wherever the model said, so approving the name approves nothing.
 */

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

/** Read one `key = [...]` list out of a PEP 723 block. */
function readList(block: string, key: string): string[] {
	const match = block.match(new RegExp(`^[ \\t]*#[ \\t]*${key}[ \\t]*=[ \\t]*\\[(.*?)\\][ \\t]*$`, "ms"));
	if (!match) return [];
	const body = match[1] as string;
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
		const direct = /@|^(?:https?|file|git|hg|svn):/i.test(raw) || raw.includes("://");
		// The name is everything before the first version, marker or separator.
		const name = direct ? "" : normalizePackageName(raw.split(/[\s;<>=!~[(@]/)[0] ?? "");
		return { raw, name, direct };
	});
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
