# perch

`perch` finds the issues in a repository and fixes them, one verified commit at
a time. Three commands.

`scan` runs tree-sitter over every source file, scores every method, walks the
method graph from the riskiest method through its callers and callees, and asks
a TypeSafe System One model a fixed set of typed questions about each one it
reaches: is there a reachable defect, on which line, what kind, how severe;
does any call misuse its callee; does the method do what its name and comment
claim; is it documented; what refactor does it need; which neighbor to follow
next. Every answer lands in an append-only events log under a short id, and a
method is never asked about twice unless its source changes. Out of that comes
one list of issues: defects, methods too big or too nested, tangled
conditions, misnamed, misdocumented, and any method the metrics alone score as
`complex`, read or not.

`fix` works that list, most serious first. A defect goes to a fix agent that
must satisfy the verifiers before it may submit; anything else goes to a
simplify agent that must bring the file's score down with the tests still
green. Each accepted result is one commit on your current branch.

## Install

```
npm install
npm run build
npx perch --help
```

Requires Node 22+ and `git`. `scan` needs a `TYPESAFE_API_KEY`; `fix` needs
that and an `OPENAI_API_KEY` (`OPENAI_BASE_URL` overrides the endpoint).
Variables are read from the shell, then from a `.env` file in the repository
root.

## Usage

```
perch scan   [<target>] [--paths a,b] [--budget N] [--parallel N] [--force] [--all] [--out DIR] [--json] [--verbose]
perch issues [<finding-id>] [--min P] [--all] [--closed] [--out DIR] [--json]
perch fix    [<finding-id> | <path>] [--budget N] [--min P] [--model M] [--effort E] [--out DIR] [--json] [--verbose]
```

| Verb | What it does | Needs |
| --- | --- | --- |
| `scan` | Analyzes every tracked source file at `HEAD` with tree-sitter, then reads the riskiest methods with System One, walking callers and callees, up to `--budget` (default 20); methods unchanged since an earlier scan are skipped. Prints the open issues. | `TYPESAFE_API_KEY` |
| `issues` | Lists every open issue: the method, where, each issue it carries with its probability, the severity of a defect, status, and the commit once worked. Closed issues are omitted unless `--closed`; methods that no longer exist are not listed. With a finding id, everything known about that method. | nothing |
| `fix` | Works the open issues, strongest first, up to `--budget`; under a path, only those in that file or directory; with a finding id, that one. Each accepted result is one commit on your current branch. | `OPENAI_API_KEY`, `TYPESAFE_API_KEY` |

`<target>` is a local directory (default `.`, resolved to its git root) or a
GitHub repository as `owner/repo` or `https://github.com/owner/repo`, which is
cloned into `<out>/repos/<owner>/<repo>` and fetched on later runs. `<path>` is
a repository-relative file or directory. `<finding-id>` is the 8-character id
printed next to every issue; a unique prefix is enough.

`fix` commits to whatever branch is checked out and refuses to run on `main`
or `master`. The file it touches must have no uncommitted changes; a rejected
attempt leaves the checkout exactly as it was, and a checkout that changes
while a run is in progress aborts the run.

| Flag | Meaning |
| --- | --- |
| `--paths a,b` | Only consider files under these repository-relative paths. |
| `--budget N` | Stop after N methods read (`scan`) or N issues worked (`fix`) (default 20). |
| `--parallel N` | How many methods to read at once (default 8). |
| `--force` | Read every method again, even ones unchanged since an earlier scan. |
| `--min P` | Only list or work issues the model rates at P percent or more (default 50). |
| `--all` | List every row instead of the top 10. |
| `--closed` | Include closed issues. |
| `--model M` | OpenAI model for `fix` (default `gpt-5.6-luna`, or `OPENAI_MODEL`). Code is always read and judged with `jev-latest`. |
| `--effort E` | Reasoning effort for the OpenAI model's run: `none`, `low`, `medium`, `high`, `xhigh`, `max` (default `max`). |
| `--out DIR` | Results directory, default `<repo root>/.perch` (`./.perch` for GitHub targets). |
| `--json` | Print the record instead of the summary. |
| `--verbose` | Show every file analyzed, method read or skipped, model call, and command run. |

A typical session:

```
perch scan                   # read the twenty riskiest methods; the open issues
perch scan --budget 100      # read further; continues where the last scan stopped
perch issues                 # the open issues
perch issues 780f586a        # everything known about one method
git checkout -b perch/sweep  # fix commits to the current branch
perch fix --budget 5         # work the five most serious open issues, one commit each
perch fix src/metrics.ts     # work the issues in one file
perch fix 780f586a           # work one issue
```

## How a scan works

**scan** lists tracked files at `HEAD`, keeps supported source files
(JavaScript, TypeScript, Rust, Python, Go; no vendored or built files), and
runs tree-sitter over each. For every named method it records the line range,
a hash of its source, and its metrics; for every file it records the calls
each method makes and the imports that name other files. Methods in test files
are analyzed, so they can appear as callers, but are never read. Everything
is saved under `<out>/scans/<scan-id>/scan.json`.

**Reading** builds the graph from the analysis: calls resolve to methods in the same
file, through imports to methods in other scanned files, or, for Go, to
methods in the same directory. The walk keeps a stack. It takes the riskiest
unvisited method, questions it, pushes its unvisited callees and callers with
the riskiest on top, and pushes the neighbor the model said to follow above
them. When the stack empties it moves to the next riskiest method overall.
Up to `--parallel` methods are questioned at once, and reading stops after
`--budget` questions.

Each method is one HTTP request. The state carries the method with its lines
tagged `L0042|`, the comment above it, its scan metrics, its file's imports,
the source of up to eight callees with the names of their own callees, up to
eight callers with the line where they call it, and the call edges among all
of them, trimmed to stay under 48KB. The questions are:

| Question | Type | Answer |
| --- | --- | --- |
| `has_bug` | noul | Probability of a concrete behavioral defect a caller can reach. |
| `where` | choice over the method's line ids | The line, with confidence. |
| `reachable` | noul, asked only when `has_bug` is at least 50% | Probability that the flagged line is actually executable given the method's own guards. A method is not reported as a defect unless this is also at the threshold. |
| `kind_*` | one noul per defect kind | Probability of each: boundary, missing null handling, wrong return, swallowed error, state mutation, ordering, resource leak, inverted condition. |
| `severity` | score | Cosmetic, minor, major, or critical. |
| `misuse_N` | one noul per callee | Probability the call violates that callee's evident contract. |
| `misused_by_N` | one noul per caller | Probability the caller violates this method's contract or relies on what it does not guarantee. |
| `does_what_it_claims` | noul | Probability the behavior matches the name, parameters, and comment. |
| `misdocumented` | noul | Probability a caller could not learn the contract from the comment. |
| `refactor` | choice | Split, flatten, simplify conditions, deduplicate, rename, remove dead code, or none. |
| `follow` | choice over neighbors plus none | Which related method to examine next. |

The answers, the method's hash, its neighbors, and the line of code pointed at
are appended as one line to `<out>/events.jsonl` under the method's finding
id. Before questioning a method, the scan checks that log: a method whose hash
matches its last read hash is skipped without a request, though the walk
still passes through it to reach its neighbors. Editing a method changes its
hash and makes it readable again; `--force` ignores the log.

A method carries a defect when `has_bug` and `reachable` are both at least the
threshold, labeled with the most probable kind. It carries a design issue when
a refactor other than none, doubt that it does what it claims, or
`misdocumented` reaches the threshold, and `complex` when its tree-sitter risk
score is 70 or more, whether or not System One has read it. `issues` lists
every method with at least one, all of its issues on the row.

## How a defect is fixed

The generating model runs as an agent with the verifiers as tools. It writes,
checks its own work, and finishes by calling `submit`, which refuses any source
the verifiers have not passed. Perch trusts the tool results it recorded, not
anything the model says. Every request, response, tool call, and tool result
is kept on the fix record as a trace.

1. **Reachability, before anything is generated.** System One is asked, with
   the method and its callers in front of it, whether a real caller can execute
   the flagged line given the method's own guards. If not, the finding is
   closed and the generating model is never called.
2. **The prompt.** Everything System One answered about the method, every
   defect kind with its probability, the line and how sure, severity, which
   calls and callers look wrong, the design signals, with the neighborhood the
   scan used: the file's imports and module scope, the callees' source, the
   callers' source around the call site, and the call graph.
3. **The tools.**
   - `check_method(method)`: splice by line range; it must parse and may not
     add nesting, more than one branch, or more than a point of risk.
   - `verify_with_system_one(method, summary)`: the scan's defect questions
     again over the patched method, with the same neighborhood. The defect and
     its kind must look less likely than the scan found them, and no caller
     newly misused. Requires `check_method` to have passed that exact source; at
     most six per fix.
   - `submit(method, summary)`: refused unless both verifiers passed that exact
     source.
4. **Commit and record.** The method is committed on the current branch with
   the summary as the message and `perch <finding-id>` in the body. The diff
   is kept at `<out>/fixes/<fix-id>/fix.patch`, the trace on `fix.json`, and a
   `fixed` event with the commit and the before and after probabilities goes to
   `events.jsonl`.

Reasoning effort is `max` by default (`--effort` lowers it) and held constant
through the run, since the prompt cache is keyed on it. A run is cut off after
sixteen model turns. No test is run. A rejected run leaves the checkout as it
was.

## How everything else is fixed

An issue that is not a defect (too big, too nested, tangled conditions,
misnamed, misdocumented, complex) goes to the simplify agent. The target is
the file's score, the one the metrics rank by; a rewrite must measure better
and keep the tests green. System One is not asked about it: whether a rewrite
"changes behavior" turned out to be a question it answers with a shrug, and
the tests are the better judge.

1. **The prompt.** The method with the comment above it, its metrics (risk
   score, maintainability index, complexity, nesting, lines), and the same
   neighborhood the scan used.
2. **The tools.**
   - `measure(source)`: splice over the region (comment and method); it must
     parse and still contain a method of the same name; that method's risk
     score must be lower with complexity and nesting no higher; the file may not
     get deeper, more complex, or more than a point riskier.
   - `run_tests(source)`: every test that reaches the method (or the whole
     suite, when none does) must pass on the rewrite. Nothing runs before the
     model asks; a test that fails on the rewrite is run once on the original,
     and one that already fails there is ignored rather than blamed. No test
     and no suite command means no rewrite. At most six runs.
   - `submit(source, summary)`: refused unless both passed that exact source.
3. **Commit and record.** The file is committed on the current branch with the
   summary as the message; the diff is kept at
   `<out>/refactors/<id>/refactor.patch`, the trace on `refactor.json`, and a
   `refactored` event goes to `events.jsonl`.

The issues the scan raised about the method go into the prompt (a misdocumented
method needs the comment a caller needs; a misnamed one needs its name and
comment to say what it does). A method already worked by the same model is not
retried until it changes.

How the project runs its tests is discovered from the tree at `HEAD`: candidate
commands from `package.json` and its lockfile, `pyproject.toml`, `Cargo.toml`,
`go.mod`, `Makefile`, `justfile`, and `run:` lines in GitHub workflows. When
there is more than one candidate System One picks; the choice is cached under
`<out>/projects/<commit>.json`. Commands run in your checkout with your
installed dependencies, each in its own process group with a timeout and
bounded output. `scan` runs none of this.

## Development

```
npm test          # vitest over test/: CLI units and the tree-sitter analyzer
npm run typecheck # tsc over the TypeScript analyzer in src/treesitter/
npm run build     # bundle src/cli.js into dist/cli.mjs
```
