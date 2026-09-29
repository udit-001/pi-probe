/**
 * Child environment policy.
 *
 * The invariant this module enforces:
 *
 *   Model-authored code cannot read the user's secrets out of its own
 *   environment.
 *
 * That is done structurally, not by filtering: the child env is built from a
 * fixed set of names copied out of the parent. Everything else is simply not
 * there, so there is no allowlist to bypass and no rule to get subtly wrong.
 * The sweep at the bottom is defence in depth for the one way a secret can
 * re-enter -- a human adding a name to `extraEnv` in probe.config.json.
 */

/** Names copied from the parent env into the child. Nothing else crosses. */
const PASSTHROUGH = [
	// Interpreter and package manager need these to function at all.
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	// Temp dir: uv writes its scratch env here.
	"TEMP",
	"TMP",
	"TMPDIR",
	// Interpreter discovery. Not secrets.
	"VIRTUAL_ENV",
	"CONDA_PREFIX",
	"PYTHONPATH",
	"PYTHONHOME",
	"PYTHONUTF8",
	"UV_CACHE_DIR",
	"UV_PYTHON",
	"UV_NO_CONFIG",
	// TLS roots, so a probe that calls an HTTPS API still works.
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	// Proxies are routing, not credentials. Passwords inside a proxy URL are
	// the one exception, which the sweep below catches.
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	// Windows. SystemRoot in particular is required for networking and DLL
	// loading; without it a large part of the runtime misbehaves.
	"SystemRoot",
	"windir",
	"COMSPEC",
	"PATHEXT",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"ProgramW6432",
	"OS",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
];

/** Matches a name that looks like it carries a credential. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|SESSION|COOKIE|AUTH)/i;

/** Matches userinfo in a URL, e.g. the `alice:hunter2@` in a proxy setting. */
const CREDENTIAL_IN_URL = /:\/\/[^/@\s]*:[^/@\s]*@/;

export interface ChildEnvOptions {
	/**
	 * Extra variable names to copy from the parent env, declared by a human in
	 * probe.config.json. This is the escape hatch for a probe that genuinely
	 * needs a credential -- the human names it, the model never can.
	 */
	extraEnv?: readonly string[];
	/**
	 * Variables forced onto the child regardless of the parent. Used for
	 * values the probe itself depends on, never for caller-supplied data.
	 */
	forced?: Readonly<Record<string, string>>;
	/** Windows environment names are case-insensitive. */
	caseInsensitive?: boolean;
}

export interface ChildEnvReport {
	env: Record<string, string>;
	/**
	 * Names the caller asked for and did not get: an `extraEnv` entry refused
	 * for looking like a credential, or a passthrough name the sweep stripped.
	 * Secrets that were never on the passthrough list are not reported --
	 * there was no request to refuse, and naming them back would only widen
	 * the disclosure.
	 */
	dropped: string[];
}

/**
 * Build the environment a probe runs with.
 *
 * Returns the env to pass to spawn, plus the names that were refused, so the
 * tool can tell the model why a variable it expected is missing.
 */
export function buildChildEnv(
	parent: Readonly<Record<string, string | undefined>>,
	options: ChildEnvOptions = {},
): ChildEnvReport {
	const { extraEnv = [], forced = {}, caseInsensitive = false } = options;
	const fold = (name: string) => (caseInsensitive ? name.toUpperCase() : name);

	const parentIndex = new Map<string, [string, string | undefined]>();
	for (const [name, value] of Object.entries(parent)) {
		if (value !== undefined) parentIndex.set(fold(name), [name, value]);
	}

	const env: Record<string, string> = {};
	const dropped: string[] = [];
	const denied = new Set<string>();

	const take = (name: string, requested: boolean): void => {
		const hit = parentIndex.get(fold(name));
		if (!hit) return;
		const [original, value] = hit;
		if (SECRET_NAME.test(original)) {
			if (requested) denied.add(original);
			return;
		}
		env[original] = value as string;
	};

	for (const name of PASSTHROUGH) take(name, false);
	for (const name of extraEnv) take(name, true);

	// Forced values land last so they cannot be shadowed or filtered.
	for (const [name, value] of Object.entries(forced)) env[name] = value;

	// Defence in depth. A forced value is ours and a passthrough name is
	// allowlisted, but an `extraEnv` entry is human-typed and could be a slip
	// for a secret, and any allowlisted value could carry a credential inline.
	for (const [name, value] of Object.entries(env)) {
		if (name in forced) continue;
		if (SECRET_NAME.test(name) || CREDENTIAL_IN_URL.test(value)) {
			delete env[name];
			denied.add(name);
		}
	}

	return { env, dropped: [...denied].sort() };
}
