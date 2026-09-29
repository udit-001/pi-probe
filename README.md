# pi-probe

A pi tool for asking Python one question. One call runs a standalone cell,
prints the value of its last expression, and forgets everything.

The alternative is writing a file, running it, reading the output, and deleting
it. That is three round trips and a cleanup step for a question that takes one.

## Install

```sh
pi install /path/to/pi-probe
```

Needs [uv](https://docs.astral.sh/uv/) on your `PATH`. Nothing else; the
interpreter, the virtual environment, and the packages are uv's problem.

## What you get

- **One call per question.** The value of the last expression comes back, so
  the cell ends with the thing you wanted to see instead of a `print()`.
- **A clean process every time.** Nothing carries over, so nothing needs
  resetting and a result never depends on what ran before it.
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

The result of the last expression is printed, so you get the answer without
wrapping it.

Cells are independent. If the third one needs the DataFrame the second one
built, it has to build it again.

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

## What a probe is not

It is a gate on how code is *declared*, not a sandbox.

A probe runs as you, in your working directory. It can open any file you can
open, including `~/.aws/credentials` and `~/.netrc`. It can also shell out to
`uv pip install` and skip the confirmation entirely. The checks here close the
channel a model reaches by accident while trying to help you; they do nothing
about code that goes looking for another way.

If you need a guarantee rather than a default, run pi in a container.

The Windows process-kill path is implemented (`taskkill /T /F`) but the test
suite only runs on Linux, so treat it as unverified there.

## Working on it

```sh
npm install
npm test        # 92 tests, real Python, real uv
npm run typecheck
```

`src/probe.ts` owns the machinery behind one call. `src/env.ts` and
`src/deps.ts` are the two security seams, each testable on its own. `index.ts`
is the adapter that registers the tool.

MIT.
