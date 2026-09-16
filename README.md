# perch

`perch` hunts for bugs in a repository by walking its method graph. A
tree-sitter pass scores every method and records which methods call which. The
hunt starts at the riskiest method, walks its callers and callees, and asks a
TypeSafe System One model a fixed set of typed questions about each one: is
there a reachable defect, on which line, which kind, how severe, does any call
misuse its callee or any caller misuse it, does the method do what it claims,
is it documented, what refactor does it need, and which neighbor to follow
next. Every answer lands in an append-only events log under a short finding
id, and a method is never asked about twice unless its source changes. What
comes back is one list of issues: defects, refactors, methods that do not do
what they claim, methods a caller cannot learn the contract of. `fix` works
the defects, `refactor` the methods the scan scores worst, each as a commit on
your current branch checked by the tests that reach the method, the metrics,
and System One. `scan` and `hunt` never write to your working tree.

## Install

```
npm install
npm run build
npx perch --help
```

Requires Node 22+ and `git`. `hunt` needs a `TYPESAFE_API_KEY`; `fix` and
`refactor` need that and an `OPENAI_API_KEY` (`OPENAI_BASE_URL` overrides the
endpoint). Variables are read from the shell, then from a `.env` file in the
repository root.

## Usage

```
perch scan     [<target>] [--paths a,b] [--all] [--out DIR] [--json] [--verbose]
perch hunt     [<target>] [--paths a,b] [--budget N] [--parallel N] [--force] [--out DIR] [--json] [--verbose]
perch issues   [<finding-id>] [--min P] [--all] [--closed] [--out DIR] [--json]
perch fix      [<path>|<finding-id>] [--budget N] [--min P] [--model M] [--effort E] [--out DIR] [--json] [--verbose]
perch refactor [<path>] [--budget N] [--min R] [--model M] [--effort E] [--out DIR] [--json] [--verbose]
perch report   [--out DIR] [--json]
```

| Verb | What it does | Needs |
| --- | --- | --- |
| `scan` | Analyzes every tracked source file at `HEAD`, records each file and method with its metrics, calls, and imports, and ranks the files by risk. Reads blobs straight from git: no worktree, no commands, no model. | `git` |
| `hunt` | Walks the method graph from riskiest down within a budget, asking the System One model about each method once, several at a time. Runs `scan` first if needed. | `TYPESAFE_API_KEY` |
| `issues` | Lists every open issue from every hunt so far: the method, each issue it carries with its probability (the defect kind, the refactor it needs, does not do what it claims, misdocumented), the severity of a defect, status, and the commit once fixed. Closed findings are omitted unless `--closed`. With a finding id, prints every answer for that method. | nothing |
| `fix` | Works the open defects, most likely first, up to `--budget`; under a path, only those in that file or directory. System One first confirms the flagged line is reachable; then an OpenAI model runs as an agent with the verifiers as tools (`check_method`: the patch parses and does not grow; `verify_with_system_one`: the defect looks less likely and nothing else changed) and finishes with `submit`, which refuses source the verifiers have not passed. Each accepted fix is one commit on your current branch. A method that changed since the hunt is re-questioned first. | `OPENAI_API_KEY`, `TYPESAFE_API_KEY` |
| `refactor` | Independent of the hunt. Takes the methods the scan scores at risk `--min` or more, riskiest first, up to `--budget`; under a path, only those in that file or directory. An OpenAI model runs as an agent with the verifiers as tools (`measure`: the method comes out less risky and no more complex; `run_tests`: the tests that reach it still pass; `verify_with_system_one`: behavior unchanged) and finishes with `submit`, which refuses source the three have not passed. Each accepted rewrite is one commit on your current branch. | `OPENAI_API_KEY`, `TYPESAFE_API_KEY` |
| `report` | Prints the latest hunt. | nothing |

`<target>` is a local directory (default `.`, resolved to its git root) or a
GitHub repository as `owner/repo` or `https://github.com/owner/repo`, which is
cloned into `<out>/repos/<owner>/<repo>` and fetched on later runs. `<path>` is
a repository-relative file or directory. `<finding-id>` is the 8-character id
printed next to every finding; a unique prefix is enough.

`fix` and `refactor` commit to whatever branch is checked out and refuse to
run on `main` or `master`. The file they touch must have no uncommitted
changes; a rejected attempt leaves the checkout exactly as it was.

| Flag | Meaning |
| --- | --- |
| `--paths a,b` | Only consider files under these repository-relative paths (`scan`, `hunt`). |
| `--budget N` | Stop after N methods questioned (`hunt`) or N findings worked (`fix`, `refactor`) (default 20). |
| `--parallel N` | How many methods to question at once (default 8). |
| `--force` | Question every method again, even ones unchanged since an earlier hunt. |
| `--min N` | `issues` and `fix`: only methods the model rates at N percent or more (default 50). `refactor`: only methods with a risk score of N or more (default 70). |
| `--all` | List every row instead of the top 10 (`scan`, `hunt`, `issues`, `report`). |
| `--closed` | Include closed findings on `issues` (every attempt to fix them was rejected). |
| `--model M` | OpenAI model for `fix` and `refactor` (default `gpt-5.6-luna`, or `OPENAI_MODEL`). Code is always questioned with `jev-latest`. |
| `--effort E` | Reasoning effort for the OpenAI model's run: `none`, `low`, `medium`, `high`, `xhigh`, `max` (default `max`). Held constant through a run; the prompt cache is keyed on it. |
| `--out DIR` | Results directory, default `<repo root>/.perch` (`./.perch` for GitHub targets). |
| `--json` | Print the record instead of the summary. |
| `--verbose` | Show every file analyzed, method questioned or skipped, model call, and command run. |

A typical session:

```
perch scan                            # the riskiest files and the size of the graph
perch hunt --budget 40                # question forty methods, riskiest first
perch issues                          # everything open: defects, refactors, misaligned and misdocumented methods
perch issues 780f586a                 # every answer about one method
git checkout -b perch/sweep           # fix and refactor commit to the current branch
perch fix --budget 5                  # fix five open defects, one commit each
perch refactor src/treesitter/metrics.ts  # simplify the riskiest methods in one file, one commit each
perch hunt --budget 40                # continues where the last hunt stopped
perch hunt --force                    # start over, ignoring earlier hunts
```

## How a hunt works

**scan** lists tracked files at `HEAD`, keeps supported source files
(JavaScript, TypeScript, Rust, Python, Go; no vendored or built files), and
runs tree-sitter over each. For every named method it records the line range,
a hash of its source, and its metrics; for every file it records the calls
each method makes and the imports that name other files. Methods in test files
are analyzed, so they can appear as callers, but are never hunted. Everything
is saved under `<out>/scans/<scan-id>/scan.json`.

**hunt** builds the graph from the scan: calls resolve to methods in the same
file, through imports to methods in other scanned files, or, for Go, to
methods in the same directory. The walk keeps a stack. It takes the riskiest
unvisited method, questions it, pushes its unvisited callees and callers with
the riskiest on top, and pushes the neighbor the model said to follow above
them. When the stack empties it moves to the next riskiest method overall.
Up to `--parallel` methods are questioned at once, and the hunt stops after
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
id. Before questioning a method, hunt checks that log: a method whose hash
matches its last hunted hash is skipped without a request, though the walk
still passes through it to reach its neighbors. Editing a method changes its
hash and makes it huntable again; `--force` ignores the log.

A method carries a defect when `has_bug` and `reachable` are both at least the
threshold, labeled with the most probable kind. It carries a design issue when
a refactor other than none, doubt that it does what it claims, or
`misdocumented` reaches the threshold. `issues` lists every method with at
least one, all of its issues on the row.

## How a fix is checked

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
   hunt used: the file's imports and module scope, the callees' source, the
   callers' source around the call site, and the call graph.
3. **The tools.**
   - `check_method(method)`: splice by line range; it must parse and may not
     add nesting, more than one branch, or more than a point of risk.
   - `verify_with_system_one(method, summary)`: the hunt's questions again
     over the patched method, with the same neighborhood, plus one about
     collateral change. The defect and its kind must look less likely than the
     hunt found them, no caller newly misused, nothing changed beyond the
     defect. Requires `check_method` to have passed that exact source; at most
     six per fix.
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

## How a refactor is checked

`refactor` does not use the hunt. It works from the scan: the methods whose
tree-sitter metrics say they are hard to maintain, riskiest first. The model
runs as the same kind of agent, with one more tool, because a refactor has no
failing test to prove it: it must measure better, keep the tests green, and do
the same thing.

1. **The prompt.** The method with the comment above it, its metrics (risk
   score, maintainability index, complexity, nesting, lines), and the same
   neighborhood the hunt would show.
2. **The tools.**
   - `measure(source)`: splice over the region (comment and method); it must
     parse and still contain a method of the same name; that method's risk
     score must be lower with complexity and nesting no higher; the file may not
     get deeper, more complex, or more than a point riskier.
   - `run_tests(source)`: every test that reaches the method and passed on the
     original (or the whole suite, when none does) must pass on the rewrite. No
     passing test and no suite command means no refactor. At most six runs.
   - `verify_with_system_one(source, summary)`: the two versions compared with
     the same neighborhood: behavior unchanged for any input the callers can
     pass, no defect picked up, the name still true. At most six.
   - `submit(source, summary)`: refused unless all three passed that exact
     source.
3. **Commit and record.** The file is committed on the current branch with the
   summary as the message; the diff is kept at
   `<out>/refactors/<id>/refactor.patch`, the trace on `refactor.json`, and a
   `refactored` event goes to `events.jsonl`.

A method already worked by the same model is not retried until it changes.

How the project runs its tests is discovered from the tree at `HEAD`: candidate
commands from `package.json` and its lockfile, `pyproject.toml`, `Cargo.toml`,
`go.mod`, `Makefile`, `justfile`, and `run:` lines in GitHub workflows. When
there is more than one candidate System One picks; the choice is cached under
`<out>/projects/<commit>.json`. Commands run in your checkout with your
installed dependencies, each in its own process group with a timeout and
bounded output. `hunt` runs none of this.

## Development

```
npm test          # vitest over test/: CLI units and the tree-sitter analyzer
npm run typecheck # tsc over the TypeScript analyzer in src/treesitter/
npm run build     # bundle src/cli.js into dist/cli.mjs
```
