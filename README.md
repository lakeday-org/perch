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

`fix` works that list, most serious first. One agent, given every issue on
the method as an objective and the scan itself as the judge: a rewrite is
accepted when the same scan, run again over it, finds every issue gone or
lower and nothing new, and the tests that reach the method still pass. Each
accepted rewrite is one commit on your current branch.

## Install

```
npm install
npm run build
npx perch --help
```

Requires Node 22+ and `git`. `scan` needs `TYPESAFE_API_KEY`; `fix` needs that
and `OPENAI_API_KEY`.

## Usage

```
perch scan   [<target>] [--paths a,b] [--parallel N] [--force] [--all] [--out DIR] [--json] [--verbose]
perch issues [<finding-id>] [--min P] [--all] [--closed] [--out DIR] [--json]
perch fix    [<finding-id> | <path>] [--budget N] [--min P] [--model M] [--effort E] [--out DIR] [--json] [--verbose]
```

| Verb | What it does | Needs |
| --- | --- | --- |
| `scan` | Analyzes every tracked source file at `HEAD` with tree-sitter, then reads methods with System One, walking from the riskiest through callers and callees. The first scan reads every method; later scans read only methods whose code changed since they were last read. Prints the open issues. | `TYPESAFE_API_KEY` |
| `issues` | Lists every open issue: the method, where, each issue it carries with its probability, the severity of a defect, status, and the commit once worked. Closed issues are omitted unless `--closed`; methods that no longer exist are not listed. With a finding id, everything known about that method. | nothing |
| `fix` | Works the open issues, most serious first, up to `--budget`; under a path, only those in that file or directory; with a finding id, that one. Each accepted result is one commit on your current branch. | `OPENAI_API_KEY`, `TYPESAFE_API_KEY` |

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
| `--budget N` | Work at most N issues (default 20). |
| `--parallel N` | How many methods to read at once (default 8). |
| `--force` | Read every method again, even ones unchanged since the last scan. |
| `--min P` | Only list or work issues the model rates at P percent or more (default 50). |
| `--all` | List every row instead of the top 10. |
| `--closed` | Include closed issues. |
| `--model M` | OpenAI model for `fix` (default `gpt-5.6-luna`, or `OPENAI_MODEL`). Code is always read and judged with `jev-latest`. |
| `--effort E` | Reasoning effort for the OpenAI model's run: `none`, `low`, `medium`, `high`, `xhigh`, `max` (default `medium`). |
| `--out DIR` | Results directory, default `<repo root>/.perch` (`./.perch` for GitHub targets). |
| `--json` | Print the record instead of the summary. |
| `--verbose` | Show every file analyzed, method read or skipped, model call, and command run. |

A typical session:

```
perch scan                   # the first time: read every method; the open issues
perch scan                   # later: read only what changed since
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
Up to `--parallel` methods are questioned at once.

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
| `exposed` | noul | Does anything from outside the program reach this method, or does it act on the world outside? |
| `security_*` | noul, one per class | Sixteen: injection, path traversal, unsafe deserialization, secret exposure, missing authorization, unvalidated destination, resource exhaustion, unsafe reflection, disabled safeguard, weak crypto, buffer overflow, use after free, uninitialised use, integer overflow, race condition, type confusion. The first eight need something from outside to reach the method, so they are listed only when `exposed` also clears the threshold; the rest are wrong on their own terms and are listed either way. |
| `severe_data_or_security` | noul | Can it destroy, corrupt, or expose data, or get past a check? |
| `severe_normal_use` | noul | Does a caller meet it on an ordinary path? |
| `severe_recoverable` | noul | When a caller hits it, can it tell and carry on? |
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

Severity is the worst band those three answers support: `P0` data lost, corrupted,
exposed, or a check bypassed; `P1` a caller meets it in normal use; `P2` it is rare
or the caller can recover; `P3` none of the above. They are three yes/no questions
rather than one rating because a single four-point score came back between 1.2 and
2.3 on every method of a real repository, which rounds to one label and says
nothing. Severity is only shown for a method that carries a defect.

## How an issue is fixed

The generating model runs as an agent with the verifiers as tools. It writes,
checks its own work, and finishes by calling `submit`, which refuses any source
the verifiers have not passed. Perch trusts the tool results it recorded, not
anything the model says. Every tool call and result is kept on the fix record
as a trace, with the tokens each model used and what they cost.

1. **Reading again, if needed.** A method that changed since the scan, or one
   the metrics flagged that System One never read, is read first; the issues
   come from that fresh reading.
2. **Reachability, before anything is generated.** For a defect, System One is
   asked, with the method and its callers in front of it, whether a real
   caller can execute the flagged line. If not, the defect is dropped; if
   nothing else is open on the method, the issue is closed and the generating
   model is never called.
3. **The prompt.** Every issue on the method as an objective, each with what
   the rescan must find (a defect gone; a design issue lower; a misdocumented
   method with the comment a caller needs; a complex file with a lower risk
   score); everything System One answered, every defect kind with its
   probability, the line and how sure, severity, which calls and callers look
   wrong; the file's metrics; and the neighborhood the scan used: imports and
   module scope, the callees' source, the callers' source around the call
   site, and the call graph.
4. **The tools.** They are the model's to use in any order and as often as it
   needs; perch does not drive it through a fixed sequence.
   - `read(path)`: any file tracked at the revision, with line numbers, or the
     listing of a directory. The
     prompt carries the neighborhood, not the repository, so this is how the
     model checks a caller it must keep working, a callee's real contract, or a
     test that covers the method.
   - `measure(source)`: splice over the region (comment, method, and any sibling
     helpers) and measure with tree-sitter. It must parse, still contain a
     method of the same name, and leave the file no worse: risk within five
     points, complexity within two (or 5%), and lines within twenty-five (or
     10%) of where they started. Extracting helpers costs a few lines and that
     is allowed; a rewrite that inflates the file has moved the mess rather than
     removed it. Whether the issues cleared is judged by rescan, not here.
   - `rescan(source)`: the same scan over the rewrite, the same System One
     questions with the same neighborhood plus the metrics. Every issue the
     scan raised must be gone (no longer listed at the threshold), a defect gone
     outright, and nothing new may appear. A 1% nudge is not enough. At most six
     per fix.
   - `run_tests(source)`: every test that reaches the method (or the whole
     suite, when none does) must pass on the rewrite. A test that fails on the
     rewrite is run once on the original, and one that already fails there is
     ignored rather than blamed. At most six runs.
   - `submit(source, summary, notes)`: refused unless measure, rescan, and
     run_tests all passed that exact source. The summary is the commit line: one
     line, under 72 characters. The notes are two or three sentences of plain
     technical English for the reviewer, saying what was wrong, what changed,
     and what is better now; bullets, marketing words, and openings like "This
     change" are refused.
5. **Commit and record.** The file is committed on the current branch with the
   summary as the message and `perch <finding-id>` in the body. The diff is
   kept at `<out>/fixes/<fix-id>/fix.patch`, the trace on `fix.json`, and a
   `fixed` event with the commit, the notes, and the issues before and after
   goes to `events.jsonl`. What perch then prints is that record: what was
   wrong, the model's notes, the metrics that actually moved, the tests that
   passed, and the cost.

Reasoning effort is `medium` by default (`--effort` raises or lowers it) and held constant
through the run, since the prompt cache is keyed on it. Several tools may be
called in one turn and they run in the order given, so one attempt need not cost
five turns. Forty turns is the backstop; a run ends itself once the rescans or
the test runs are spent with nothing passing. A rejected run leaves the checkout as it was, and a method
already worked by the same model is not retried until it changes.

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
