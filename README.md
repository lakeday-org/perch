# perch

[![npm](https://img.shields.io/npm/v/@lakeday/perch)](https://www.npmjs.com/package/@lakeday/perch)
[![ci](https://github.com/lakeday-org/perch/actions/workflows/ci.yml/badge.svg)](https://github.com/lakeday-org/perch/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@lakeday/perch)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@lakeday/perch)](LICENSE)

perch finds bugs and design problems in a repo and fixes them.

`perch scan` parses every tracked file with tree-sitter and scores each method.
It then asks a TypeSafe System One model a fixed set of questions about each
one. Every answer is a probability, so nothing comes back as a verdict. Methods
are sorted worst first.

`perch fix` hands a method to an OpenAI-compatible model with its issues as
objectives. The rewrite is committed only if a second scan expects fewer
problems, your tests still pass, and your linter and type checker still pass.

## Getting started

```sh
# 1. install
npm install -g @lakeday/perch

# 2. the key that reads code
export TYPESAFE_API_KEY=...

# 3. scan (later runs only re-read methods that changed)
perch scan

# 4. see what it found
perch issues

# 5. the key that writes code
export OPENAI_API_KEY=...

# 6. fix one, by the id in the first column
git checkout -b perch/sweep
perch fix 92c7781e
```

Needs Node 22+ and git. `perch fix` commits to the branch you're on and refuses
main and master.

## This repository, scanning itself

```
$ perch scan
ID        Method          Location        Type      Kind                           Severity  Status
cbc46523  analyzeTree     src/scan.js:13  docs      docs 88%, +3 more              P1 (1.3)
272b643c  scanRepository  src/hunt.js:95  refactor  too_big 94%, +2 more           P1 (1.2)  8a60a8c
538f723f  resolveTarget   …/target.js:16  security  unsafe_deserialization 91%, …  P1 (1.3)
723a2685  buildGraph      …c/graph.js:41  docs      docs 78%, +2 more              -
perch at commit 2c437e8: 386 methods, read 386
386 requests  2.4M tokens in / 319k out  $0.10
```

`P1 (1.3)` is a band and where the score landed inside it — 1.3 drifts toward P2, 0.9 is nearly P0.
A label alone would call a 33/31/30/6 spread "P0" on a third of the mass.

Rank is correctness weighted by that severity, plus design. Ten cosmetic problems do not outrank one
that loses data.

Listed at over half, because that is where a probability stops meaning no. `--min 80` for the obvious
ones, `--min 0` for everything it answered.

### Reading one method

```
$ perch issues cbc46523
cbc46523  analyzeTree  src/scan.js:13-41  at commit 8c68f0d read on 2026-09-17
Issues: docs 88%, unsafe_deserialization 83%, too_big 58%, +1 more
Metrics: risk 42, maintainability 46, complexity 3, nesting 1, 26 lines; file risk 56
Defect: 54%. Points at line 33 (confidence 19%):
    33| return Promise.race([new Promise(resolve => waiting.set(index, resolve)), reading.then(...)]);
Kind: error_ignored 53%, leak 17%, bad_state_change 11%, wrong_order 6%, unhandled_null 6%, ...
Severity: P1 (1.3) (P1 56%, P2 26%, P0 11%, P3 6%)
Exposed to outside input: 98%. Vulnerability: unsafe_deserialization 85%, uninitialized_use 82%, ...
Misuses a callee: readBlobs 32%, analyzeFiles 13%, listTree 11%, writeJson 10%, ...
Misused by a caller: fixIssues 25%, methodContext 23%, openIssues 21%, scanRepository 14%
Status: open
```

`error_ignored 53%` with the rest scattered: fairly sure something is wrong, unsure what. A
vulnerability list flat across sixteen classes usually means the method is too big to read, not that
it has sixteen holes — check that before chasing one.

`where` carries its own confidence. Pointing at the wrong line confidently is what makes people quit
a tool.

### Narrowing

```
$ perch issues --filter kind=too_big --min 80
ID        Method          Location        Type      Kind                  Severity  Status
272b643c  scanRepository  src/hunt.js:95  refactor  too_big 94%           -         8a60a8c
a4ef42d9  huntStep        …stions.js:336  refactor  too_big 91%           -
2cac2cdd  readAnswers     …stions.js:438  refactor  too_big 88%           -
```

A filter ranks by what you asked for and leads each row with it. Filtering for vulnerabilities and
getting a list ordered by method size is useless, and a row reading `refactor` under a security
filter is arguing with its own query.

### Fixing

The scan is re-run over the rewrite. The model's opinion of its own work is not an input.

```
$ perch fix 272b643c
[1/1]  272b643c  scanRepository  src/hunt.js:53
  Clear   too_big 93%, docs 87%, unsafe_deserialization 82%, bad_state_change 58%
  ✓ measure  method risk 77 -> 74, 73 -> 44 lines, file risk 87 -> 86       0.0s
  ✗ rescan   run measure on this exact source first                         0.0s
  ✓ rescan   too_big 93%, docs 88%, uninitialized_use 74%, off_by_one 54%   0.2s
  ✓ tests    3 pass                                                          11s
  ✓ submit                                                                   11s
✓ 8a60a8c Validate graph ids before scheduling hunt work

  Cleared  unsafe_deserialization 82%, bad_state_change 58%
  Left     too_big 93% -> 93%, docs 87% -> 88%
  Added    uninitialized_use 74%, off_by_one 54%
  Method   risk 77 -> 74, 73 -> 44 lines
  Tests    test/cli.test.js, test/fix.test.js, test/hunt.test.js pass
  Cost     $0.02
```

Pareto: neither correctness nor design may get worse and one must get better. No threshold — halving
a defect counts as exactly that, and a new problem costs whatever the model believes of it. A fix
cannot buy correctness with shape or shape with bugs.

`Cleared / Left / Added` instead of two lists to diff by eye.

`submit` also runs your lint, typecheck and tests, found in your manifests and CI rather than guessed
from names. Passing the tests that reach a method does not mean the build still works.

In that same run perch gave up on `fixMethod`, 246 lines, after three attempts no rescan would pass.
Refusing cost a penny.

### Issues you do not want fixed

```sh
perch close e585492e --reason "verifies the HMAC before parsing"
```

A false positive returning every scan makes the whole list worth less. Closed issues stop being
listed and `perch fix` skips them. The dismissal is against the method as it reads now, so editing it
brings the issue back — you dismissed the code, not the name.

A method perch cannot read is recorded and skipped rather than ending the run; `perch doctor` prints
what happened.

## Commands and flags

`perch --help`, and `perch <command> --help` for one of them.

| | |
| --- | --- |
| `perch scan [<target>]` | `<target>` is a directory, or a GitHub repo as `owner/repo` or a URL, cloned under `<out>/repos/`. Defaults to `.`, resolved to its git root. |
| `perch issues [<issue-id>]` | The 8-character id in the first column. A unique prefix works. |
| `perch close` / `perch reopen` | Take ids the same way. |
| `perch fix [<issue-id> \| <path>]` | An id, or a file or directory to work everything under. |
| `perch doctor` | Takes nothing. |

`perch findings` is another name for `perch issues`.

### Environment

| | |
| --- | --- |
| `TYPESAFE_API_KEY` | `scan`, and the rescan `fix` is judged by. |
| `OPENAI_API_KEY` | `fix`. |
| `OPENAI_MODEL` | Which model writes the fix. `--model` overrides it. |
| `OPENAI_BASE_URL` | Any endpoint that speaks the OpenAI Responses API. |

## How it works

- [doc/scan.md](doc/scan.md) — the graph walk, the questions, and how
  probabilities turn into a ranking.
- [doc/fix.md](doc/fix.md) — the agent, its verifiers, and what a rewrite has to
  beat to get committed.

Results go in `<out>`: an append-only `events.jsonl` with one line per method
read and per fix made, plus scan, hunt and fix records. Nothing else is written
to your tree except the commits `fix` makes.

## Development

```sh
npm run check     # lint, typecheck, test
npm run build     # bundle src/cli.js into dist/cli.mjs
```

From a checkout: `npm install && npm run build && npm link` puts `perch` on your
path.
