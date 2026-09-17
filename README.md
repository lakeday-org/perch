# perch

`perch` reads your codebase with tree-sitter and TypeSafe System One models to
**triage** it: every method graded by how much trouble it is expected to cause,
worst first. Then it fixes what it found, one verified commit at a time.

Nothing is decided by a cutoff. Every answer is a probability and every method
is ranked by the arithmetic on those probabilities — see [doc/scan.md](doc/scan.md).

## Getting started

```sh
# 1. install
npm install -g @lakeday/perch

# 2. the key that reads code
export TYPESAFE_API_KEY=...

# 3. grade every method (later runs read only what changed)
perch scan

# 4. see what it found
perch issues

# 5. the key that writes code
export OPENAI_API_KEY=...

# 6. fix one, by the id in the first column
git checkout -b perch/sweep
perch fix 92c7781e
```

Needs Node 22+ and `git`. `perch fix` commits to the branch you are on and
refuses `main` and `master`.

Keys can go in a `.env` at your repository root instead of the environment.

## Commands

```
perch scan   [<target>] [--paths a,b] [--parallel N] [--force] [--all]
perch issues [<issue-id>] [--filter k=v] [--types] [--min P] [--all] [--closed]
perch fix    [<issue-id> | <path>] [--filter k=v] [--budget N] [--min P] [--effort E]
```

All three take `--out DIR`, `--json` and `--verbose`.

| Verb | What it does | Needs |
| --- | --- | --- |
| `scan` | Grades every tracked source file at `HEAD` with tree-sitter, then reads methods with System One, walking the call graph from the riskiest through its callers and callees. The first scan reads every method; later scans read only what changed. Prints the table. | `TYPESAFE_API_KEY` |
| `issues` | The open issues, worst first: the method, where, what kind of problem and how likely, the predicted severity, and the commit that fixed it. With an id, everything known about that method. | nothing |
| `fix` | Works the open issues, worst first, up to `--budget`; with a path, only under it; with an id, that one. Each accepted rewrite is one commit. | both keys |

`perch findings` is another name for `perch issues`.

### Reading the table

```
ID        Method       Location        Type      Kind                            Severity  Status  Commit
92c7781e  fixMethod    src/fix.js:224  refactor  too_big 98%, unsafe_deser 87%   P1 (0.9)  open    -
```

* **Type** is the class the row leads with, one of `defect`, `security`,
  `refactor`, `misdocumented`, `misaligned`.
* **Kind** is the named problem and how sure the model is, strongest first.
* **Severity** is the band, with where the score actually landed inside it.
  `P1 (0.9)` is almost `P0`; `P1 (1.2)` is settling toward `P2`. Only a method
  carrying a defect has one.

`--filter` narrows on exactly those columns, and `--types` prints everything it
accepts:

```sh
perch issues --filter type=security          # every method carrying a vulnerability
perch issues --filter kind=too_big --min 80  # the ones it is at least 80% sure are too big
perch fix --filter severity=P1 --budget 5
```

A filtered list prints every match and leads each row with what you filtered
for. An unfiltered one is cut to ten rows unless you pass `--all`.

### Flags

| Flag | Meaning |
| --- | --- |
| `--paths a,b` | Only consider files under these repository-relative paths. |
| `--parallel N` | How many methods to read at once (default 8). |
| `--force` | Read every method again, even ones unchanged since the last scan. |
| `--filter k=v` | Keep only issues matching, e.g. `type=security,severity=P1`. |
| `--types` | Print everything `--filter` accepts and stop. |
| `--min P` | Only methods expected to have more than P problems, where one certain issue is 100 (default 0: everything, ranked). |
| `--budget N` | Work at most N issues (default 20). |
| `--effort E` | Reasoning effort: `none`, `low`, `medium`, `high`, `xhigh`, `max` (default `medium`). |
| `--all` | List every row instead of the top ten. |
| `--closed` | Include closed issues. |
| `--out DIR` | Results directory, default `<repo root>/.perch`. |
| `--json` | Print the record instead of the table. |
| `--verbose` | Show every file, method, model call, and command. |

`<target>` is a local directory (default `.`, resolved to its git root) or a
GitHub repository as `owner/repo` or a URL, cloned under `<out>/repos/`.
`<issue-id>` is the 8-character id in the first column; a unique prefix works.

## How it works

* [doc/scan.md](doc/scan.md) — the graph walk, the questions, and the
  arithmetic that turns probabilities into a ranking.
* [doc/fix.md](doc/fix.md) — the agent, its verifiers, and the Pareto test a
  rewrite has to pass.

Results live in `<out>`: an append-only `events.jsonl` with one line per method
read and per fix made, plus the scan, hunt and fix records. Nothing is written
to your working tree except the commits `fix` makes.

## Development

```sh
npm test          # vitest: the CLI, the walk, the fix agent, the analyzer
npm run typecheck # tsc over src/treesitter/
npm run build     # bundle src/cli.js into dist/cli.mjs
```

From a checkout, `npm install && npm run build && npm link` puts `perch` on your
path.
