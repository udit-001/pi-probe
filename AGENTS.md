# AGENTS.md

## What this is

pi-probe is a pi extension: one `probe` tool for asking Python a question. A
call runs a standalone cell in a fresh process, returns the value of its last
expression, and forgets everything the cell did not save to WORKSPACE.

The agent-facing contract lives in `index.ts` (`DESCRIPTION`, `promptSnippet`,
`promptGuidelines`) -- that text is what a pi agent reads to decide when to
use the tool. When behavior changes, change that text in the same commit; the
two are one surface and drift between them is the failure mode.

## The invariants

Each module exists to hold one of these. Breaking one makes the tool unsafe to
hand to a model, so changes are judged against them.

1. **A probe is a fresh process with an empty namespace.** User code runs in
   its own dict (`_ns` in the runner) -- no runner global is visible unless
   the runner hands it in by name. WORKSPACE is the only thing handed in, and
   the only thing that outlives a call.
2. **The deps gate approves names, never bytes.** A package must be
   human-approved (once per session) before uv installs it; a URL, VCS
   location, or path is refused outright; the metadata block handed to uv is
   rebuilt from parsed names, never forwarded, so a `[tool.uv]` index
   override cannot be smuggled under a clean-looking name. The gate covers
   the declaration path only -- a probe runs as the user and can shell out to
   `uv pip install` itself. That is documented, not a bug.
3. **The child environment is inherited, not filtered.** It is built from a
   fixed list of names copied out of the parent; secret-shaped names are
   dropped even when a human lists them; forced values land last so nothing
   shadows them.
4. **The workspace is keyed by session id and never trusted by name alone.**
   `resolveWorkspace` creates with non-recursive mkdir, re-stats the result
   (not a symlink, ours, mode 0700), and falls back to a fresh random
   directory on any doubt -- a planted path is never reused, and the
   workspace must never resolve to the working directory, where a probe
   writing "somewhere safe" would silently litter the project.
5. **Windows is best-effort.** The kill path uses `taskkill /T /F` and the
   uid check is skipped (`process.getuid` does not exist there); the suite
   only runs on Linux. Windows-specific paths are treated as unverified.

## Where things live

- `src/probe.ts` -- one call: spawn, bounded head-and-tail capture, kill the
  whole tree on timeout or abort.
- `src/env.ts` and `src/deps.ts` -- invariants 3 and 2: the child env and the
  declaration gate, each testable on its own.
- `src/workspace.ts` -- invariant 4: identity-keyed, validated session
  scratch with stale pruning.
- `src/runner.ts` -- the Python preamble: REPL-style last-expression output,
  traceback lines that point at the user's code, WORKSPACE handed into the
  cell namespace.
- `src/view.ts` -- every rendering of one outcome: the model's text, the shut
  and open TUI views, and the call line, each laid out to a width the host
  supplies. The state classification, the duration format, the label
  vocabulary, and the timeout advice are decided once in `summarize` and read
  four times; a view that decides any of them itself is a view that will drift
  from the others.
- `index.ts` -- the adapter that registers the tool, resolves the session id,
  owns the agent-facing description, and is the only module that knows pi: the
  `ViewPort` adapter, and the `viewLines` shim that satisfies pi's render
  interface by building a view per width and caching the last one.

## Changing it

- Finish a change with `npm run typecheck` then `npm test` (real Python,
  real uv). Single file while iterating: `node --test tests/<file>.test.ts`.
- Tests assert behavior at seams, never internals: workspace behavior through
  `resolveWorkspace` (`tests/workspace.test.ts`), cell behavior through
  `runProbe` (`tests/probe.test.ts`), rendering through the four functions in
  `src/view.ts` (`tests/view.test.ts`). A bug in `ensureOwnedDir` or
  `pruneStale` is caught by a test that goes through `resolveWorkspace`, not by
  poking the helpers.
- The view port (`fg`, `bold`, `expandHint`, `wrap`) has two adapters -- pi's
  live theme plus `truncateToVisualLines`, and the plain one in
  `tests/view.test.ts` -- so a test can assert the words through one and the
  colour choices through the recording one. `keyHint` stays in `index.ts`:
  it reads process-global theme and keybinding state and throws outside a live
  TUI, so importing it into `src/view.ts` would cost the module its purity.
  `wrap` is in the port for the same reason, and because the two adapters
  genuinely differ -- the test one wraps plainly, so "three visual lines" stays
  a statement about these views and not about pi's wrapping policy. If you
  ever add a third member, hold it to the same bar: two adapters, or it is
  indirection.
- A view receives a width and returns lines; it never learns the terminal's
  width itself, and it never hands back a line wider than what it was given.
  The one place a view may reach a fixed number is `textView`, which is the
  model's text and is not laid out at all.
- Keep user-facing copy -- and only that -- in the README; security-model
  truth and dev workflow live in this file.