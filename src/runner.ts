/**
 * The runner. A small Python preamble that behaves like a REPL tail.
 *
 * It lives in its own file and reads the user's code from a second file, for
 * two reasons that a single combined file gets wrong:
 *
 *  - Python compiles a whole module before running any of it, so a syntax
 *    error in user code would be reported against the preamble's line numbers.
 *    Two files means the reported line is the line the model actually wrote.
 *  - Tracebacks resolve source through `linecache`, which finds the second
 *    file on disk. No cache surgery needed, and the frames we do not want
 *    (our own `exec` call) can be trimmed by walking one link down the chain.
 *
 * The trailing expression is printed the way a REPL prints it. `compile` in
 * "single" mode would do this for free but rejects any cell with more than
 * one top-level statement, so the last statement is split out with `ast`
 * instead.
 */

/**
 * Build the runner source that executes `userPath`.
 *
 * `startedPath` is touched as the very first thing, before any user code. Its
 * presence is the only trustworthy answer to "did the interpreter ever get
 * your code running?", which is what separates a timeout spent installing
 * packages from a timeout spent computing. Guessing that from stderr does not
 * work: uv writes "Installed 4 packages" and then the cell runs forever, and
 * the two cases need opposite advice.
 */
export function buildRunner(userPath: string, metadataBlock: string, startedPath?: string): string {
	const preamble = `import ast as _pa, os as _po, sys as _ps

# The probe workspace: the one thing that outlives a probe. WORKSPACE is a
# tool-owned scratch directory that survives until the session ends, so an
# expensive step (a fetch, a slow parse) can run once, land here, and be read
# back by later probes. The agent reaches for it by name; nothing else from a
# previous probe is in reach.
_P = ${JSON.stringify(userPath)}

# Without a provider (no session behind the call) WORKSPACE falls back to this
# run's own scratch directory -- writable, but gone when the run ends. It must
# never fall back to the working directory: a probe that writes somewhere
# "safe" unknowingly would litter the project the user is actually working in.
WORKSPACE = _po.environ.get("PI_PROBE_WORKSPACE") or _po.path.dirname(_P)
${startedPath ? `open(${JSON.stringify(startedPath)}, "w").close()` : "pass"}
_po.sys.path.insert(0, _po.getcwd())
_src = open(_P, encoding="utf-8").read()
_tree = _pa.parse(_src, _P)
_last = _tree.body.pop().value if _tree.body and isinstance(_tree.body[-1], _pa.Expr) else None
# User code runs in its own namespace, so WORKSPACE must be handed in -- it
# is not a runner global the cell can see by accident.
_ns = {"__name__": "__main__", "__file__": _P, "WORKSPACE": WORKSPACE}
try:
    exec(compile(_tree, _P, "exec"), _ns)
    if _last is not None:
        _ps.displayhook(eval(compile(_pa.Expression(_last), _P, "eval"), _ns))
except SystemExit:
    raise
except BaseException as _e:
    import traceback as _tb
    _tb.print_exception(type(_e), _e, _e.__traceback__.tb_next)
    raise SystemExit(1)
raise SystemExit(0)
`;
	// The PEP 723 block has to be the first thing in the file for uv to read
	// it. It is comments, so it costs nothing to lift it to the top.
	return (metadataBlock ? `${metadataBlock}\n` : "") + preamble;
}
