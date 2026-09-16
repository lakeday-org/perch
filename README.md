# perch

`perch` hunts for bugs in a repository by walking its method graph. A
tree-sitter pass scores every method and records which methods call which. The
hunt starts at the riskiest method, walks its callers and callees, and asks a
TypeSafe System One model a fixed set of typed questions about each one: is
there a reachable defect, on which line, which kind, how severe, does any call
misuse its callee or any caller misuse it, does the method do what it claims,
is it documented, what refactor does it need, and which neighbor to follow
next. Every answer lands in an append-only events log under a short finding
id, and a method is never asked about twice unless its source changes. Nothing
is written to your working tree.

## Install

```
npm install
npm run build
npx perch --help
```

Requires Node 22+ and `git`. `hunt` needs a `TYPESAFE_API_KEY`; `fix` needs
that and an `OPENAI_API_KEY` (`OPENAI_BASE_URL` overrides the endpoint);
`publish` needs the GitHub CLI (`gh`) logged in. Variables are read from the
shell, then from a `.env` file in the repository root.

## Usage

```
perch scan    [<target>] [--paths a,b] [--all] [--out DIR] [--json] [--verbose]
perch hunt    [<target>] [--paths a,b] [--budget N] [--parallel N] [--force] [--out DIR] [--json] [--verbose]
perch issues  [<finding-id>] [--min P] [--all] [--out DIR] [--json]
perch design  [<finding-id>] [--min P] [--all] [--out DIR] [--json]
perch fix     <finding-id> [--model M] [--keep-workspace] [--out DIR] [--json] [--verbose]
perch publish <finding-id> [--out DIR] [--json]
perch report  [--out DIR] [--json]
```

| Verb | What it does | Needs |
| --- | --- | --- |
| `scan` | Analyzes every tracked source file at `HEAD`, records each method with its metrics, calls, and imports, and ranks the methods by risk. Reads blobs straight from git: no worktree, no commands, no model. | `git` |
| `hunt` | Walks the method graph from riskiest down within a budget, asking the System One model about each method once, several at a time. Runs `scan` first if needed. | `TYPESAFE_API_KEY` |
| `issues` | Lists likely defects from every hunt so far, latest answer per method. With a finding id, prints every answer for that method. | nothing |
| `design` | Lists methods that need architectural work: a recommended refactor or a mismatch between what the method claims and does. | nothing |
| `fix` | Asks an OpenAI model for the corrected method and one regression test, checks the test with System One, proves both in a worktree of its own (the test fails on the original, passes on the patch, existing tests still pass), questions the patched method again, and writes the patch with its proof. | `OPENAI_API_KEY`, `TYPESAFE_API_KEY` |
| `publish` | Has the OpenAI model write the finding up as a bug report, then files it on GitHub: an issue; once `fix` has proven a patch, a pull request on branch `perch/fix-<id>` carrying the patch and its regression test, closing the issue; once every fix attempt has failed, closes the issue as not reproduced. An issue already carrying the finding's marker is updated, not duplicated. | `gh` logged in, `OPENAI_API_KEY` |
| `report` | Prints the latest hunt. | nothing |

`<target>` is a local directory (default `.`, resolved to its git root) or a
GitHub repository as `owner/repo` or `https://github.com/owner/repo`, which is
cloned into `<out>/repos/<owner>/<repo>` and fetched on later runs.
`<finding-id>` is the 8-character id printed next to every finding; a unique
prefix is enough.

| Flag | Meaning |
| --- | --- |
| `--paths a,b` | Only consider files under these repository-relative paths (`scan`, `hunt`). |
| `--budget N` | Stop after questioning N methods, one request each (default 20). |
| `--parallel N` | How many methods to question at once (default 8). |
| `--force` | Question every method again, even ones unchanged since an earlier hunt. |
| `--min P` | Only list methods the model rates at P percent or more (default 50). |
| `--all` | List every row instead of the top 10 (`scan`, `hunt`, `issues`, `design`, `report`). |
| `--model M` | OpenAI model for `fix` (default `gpt-5.6-luna`, or `OPENAI_MODEL`). `hunt` and `fix` always use `jev-latest` to question code. |
| `--keep-workspace` | Leave the fix's worktree under `<out>/workspaces` instead of removing it. |
| `--out DIR` | Results directory, default `<repo root>/.perch` (`./.perch` for GitHub targets). |
| `--json` | Print the record instead of the summary. |
| `--verbose` | Show every file analyzed, method questioned or skipped, and model call. |

A typical session:

```
perch scan               # the riskiest methods and the size of the graph
perch hunt --budget 40   # question forty methods, riskiest first
perch issues             # likely defects so far, most likely first
perch design             # methods that need splitting, flattening, or renaming
perch issues 780f586a    # every answer about one method
perch fix 780f586a       # fix it and prove the fix with a regression test
perch publish 780f586a   # file the issue and open the pull request (or close the issue if no fix could be proven)
perch hunt --budget 40   # continues where the last hunt stopped
perch hunt --force       # start over, ignoring earlier hunts
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

A method is reported as a likely defect when `has_bug` is at least the
threshold, with the most probable kind. It is reported as design work when a
refactor other than none, doubt that it does what it claims, or misdocumentation
reaches the threshold.

## How a fix is proven

Without a test that fails on the original and passes on the patch, a fix is
an opinion with a probability on it. `fix` makes the proof part of the record.

1. **One generative call.** The OpenAI model sees the finding, the context the
   hunt used, an existing test that reaches the method or a neighbor (so the
   new test follows the project's style), and how the project runs one test
   file. It returns the corrected method, one new regression test, the path the
   test belongs at, and a one-line summary.
2. **Splice and gate.** The method is spliced into the file by line range. The
   result must parse and must not raise cyclomatic complexity, nesting, or risk
   score. The test path must be a new file inside the repository.
3. **System One reads the test** before a run is spent on it: does it import
   the real method rather than a copy, does it exercise the flagged defect,
   does it assert on behavior rather than internals, would it pass on the
   original for the wrong reason. A test that fails goes back to the generative
   model with the reasons.
4. **Run it, twice.** In a detached worktree at the finding's commit, made for
   this fix and removed with it, the test must fail on the original with an
   assertion (not a load or import error) and pass on the patch. Then the
   existing tests the graph says reach the method (test methods that call it,
   test files that import its file) must still pass.
5. **System One questions the patched method** with the hunt's questions plus
   one about collateral change. The defect probability and the flagged kind
   must have dropped below the threshold, no caller may be newly misused, and
   nothing may have changed beyond the defect. This catches a patch that games
   the test.
6. **Record.** The patch with the test goes to `<out>/fixes/<fix-id>/fix.patch`
   and a `fixed` event with the before and after probabilities and the test
   path to `events.jsonl`, so `issues` shows the finding as proven and fixed.

Three attempts, each fed the previous rejection. When all three fail, the
finding is recorded as discarded and `issues` says so. Existing tests are run
on the original first: one that already fails there is reported but never
blamed on the patch. Test runs never see perch's own keys (`OPENAI_API_KEY`,
`TYPESAFE_API_KEY`, `OPENAI_*`). Nothing in your checkout is touched; the
`git apply` command is printed.

The regression test goes where the project keeps its tests. When the module
already has a test file (one that imports it, or whose name is the module's
name plus `test`/`spec`), the new case is added to that file: the model returns
the whole file and only additions are accepted. Otherwise a new file is created
and must be named after the module the way the project's other tests are
(`test/target.test.js`, `tests/test_target.py`, `target_test.go`); names with
invented suffixes are rejected.

**publish** turns the record into GitHub state. First the OpenAI model writes
the finding up from the code the way an engineer files a bug: a title, what
happens and for which input, how to reproduce it, what should happen, and,
once fixed, what the change does. No probabilities and no model talk; a
`perch <finding-id>` footer marks the issue so a later publish updates it
instead of filing again. A finding without a fix becomes an issue. A finding
with a proven fix becomes an issue plus a pull request: a branch
`perch/fix-<id>` is built in a worktree from the finding's commit, the patch
(method and test) committed on it, pushed to `origin`, and a pull request
opened against the default branch with `Closes #N`. A finding whose fix was
discarded gets its issue closed with the last rejection as the reason. Every
publish is appended to `events.jsonl`, so `issues` shows the write-up, the
issue, its status, and the pull request next to the finding.

How the project runs its tests is discovered from the tree at the finding's
commit: candidate commands from `package.json` and its lockfile, `pyproject.toml`,
`Cargo.toml`, `go.mod`, `Makefile`, `justfile`, and `run:` lines in GitHub
workflows. When there is more than one candidate System One picks; the choice
is cached under `<out>/projects/<commit>.json`. Dependencies are linked from
your checkout (`node_modules`, `.venv`, `target`, `vendor`) when present,
otherwise installed once in the worktree. Every command runs in its own
process group with a timeout and bounded output. `hunt` runs none of this.

## Development

```
npm test          # vitest over test/: CLI units and the tree-sitter analyzer
npm run typecheck # tsc over the TypeScript analyzer in src/treesitter/
npm run build     # bundle src/cli.js into dist/cli.mjs
```
