# pi-probe

A pi tool for asking Python one question. One call runs a standalone cell,
prints the value of its last expression, and forgets everything you did not
save to WORKSPACE.

The alternative is writing a file, running it, reading the output, and deleting
it. That is three round trips and a cleanup step for a question that takes one.

## Install

```bash
pi install git:github.com/udit-001/pi-probe
```

Needs [uv](https://docs.astral.sh/uv/) on your `PATH`. Nothing else; the
interpreter, the virtual environment, and the packages are uv's problem.

Install anywhere in the project or globally, then say `probe` — the tool
appears in the agent's list on the next turn.

## What you get

- **One call per question.** The value of the last expression comes back, so
  the cell ends with the thing you wanted to see instead of a `print()`.
- **A clean process every time.** Nothing carries over except what you save
  to WORKSPACE — no reset, no stale state, and a result never depends on
  what ran before it.
- **Real packages, cheaply.** Declare them in a header and uv resolves and
  caches them. A cold `pandas` costs about four seconds here; the environment
  is reused from then on.
- **A traceback that points at your line.** Line numbers are the ones you
  wrote, with the source line quoted underneath.
- **Approval before an install.** A package you have not approved is confirmed
  once per session. A URL or a local path is refused without asking.
- **A bounded child.** Built from a fixed list of environment variable names,
  so your tokens and keys are not in it.

## Using it

Third-party packages go in a header at the very top. uv reads it; nothing else
does.

```python
# /// script
# dependencies = ["pandas"]
# ///
import pandas as pd

df = pd.read_csv("sales.csv")
df.groupby("region")["amount"].sum().sort_values(ascending=False)
```

The result of a final top-level expression is printed, so you get the answer
without wrapping it. An expression indented inside a `for`, `if`, or `try`
block is not top-level, and prints nothing.

Cells are independent. If the third one needs the DataFrame the second one
built, it has to build it again — or park it in WORKSPACE once and read it
back.

`WORKSPACE` points at a scratch directory tied to the pi session: same
session, same directory, so a resumed conversation still finds its data
until the OS cleans the temp dir, and a new session starts with fresh
scratch. Do an expensive step once and reuse it:

```python
import json, os
p = os.path.join(WORKSPACE, "models.json")
with open(p, "w") as f: json.dump(data, f)   # first probe

data = json.load(open(p))                     # later probes
```

Workspace files carry the trust of whoever wrote them: fetched data is still
remote data. The directory is mode `0700`, re-validated on every call, and a
pre-planted symlink or a directory you do not own is refused (fresh random
fallback). Workspaces left untouched for two weeks are pruned automatically.

## Configuration

Copy `probe.config.example.json` to `probe.config.json` next to the extension
and edit it. It is gitignored, because an allowlist is your call, not the
project's.

```json
{
  "allowedPackages": ["pandas", "numpy", "requests"],
  "extraEnv": ["HTTP_PROXY", "TZ"]
}
```

`allowedPackages` skips the confirmation prompt. Anything not listed is asked
about, once per session. With no UI to ask, an unlisted package is refused and
the error names this file.

`extraEnv` lists environment variable *names* to pass through. Secret-shaped
names are refused even when you list them, so this is for a proxy or a colour
setting, never a token.

## Working on it

Security model, invariants, module map, and the dev workflow live in
[AGENTS.md](AGENTS.md) -- agents get them automatically; the README stays
user-facing.

MIT.
