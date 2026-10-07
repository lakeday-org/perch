---
name: perch
description: Semantic linting with perch. Use it to verify code changes in flight. Scan a branch or a diff. Check one method right after editing it. Confirm a fix landed before opening a pull request. Use it to lint behavior a compiler cannot check: bugs, vulnerabilities, swallowed errors, and a method that does not do what its name says. Use it to act on what a scan found, including what CI found on a pull request. Use it to check which changed lines the tests ran, and which tests are worth keeping. Use it to write rules that turn a repeated mistake into verifiable behavior.
---

# perch

perch asks a model about the code in a repository. It reports what it believes, as a probability on
every finding.

## Scan what changed

```console
$ perch scan --since origin/main
checkout.py
  ID        Line  Severity  Type    Confidence  Problem      Method
  bdc67421    14  P1 (0.8)  defect         81%  wrong_order  place_order

✖ 1 problem in 1 file, all failing
perch at commit 5e9d910: 3 methods, read 3
3 requests  10k tokens in / 2k out  $0.0004
```

`--since <ref>` covers what moved since that ref. That is what you want on a branch
and in CI. `--paths a,b` covers named files or directories. Add `--json` for the full
detail: `perch scan --since origin/main --json`.

A whole repository is hundreds of model requests. A branch is a handful. Never scan
everything to check one change.

A method whose code and neighbours have not moved is skipped next run. Scanning again
after a fix costs almost nothing.

| Exit | |
| --- | --- |
| `0` | Nothing to act on. |
| `3` | Something that fails was found. |
| `1` | perch could not run. |
| `2` | The command was typed wrong. |

`3` is a result rather than an error, so report what it found. Only `1` and `2` are
failures.

## Read the JSON

Every command takes `--json`. The table is rounded off for a terminal, and the JSON
carries the detail.

```console
$ perch issues
ID        Method             Location           Type      Kind                    Severity
05a5b5bd  scanRepository     src/scan.js:129    refactor  too_big 98%             -
b2d0885f  formatFinding      src/report.js:376  refactor  too_big 98%             -
990c94ac  scan               src/cli.js:350     refactor  too_big 92%             -
```

`perch issues <id> --json` gives one finding in full. Every question's answer carries
the distribution behind it:

```json
"has_bug": 0.46,
"kind": { "choice": "missing_null_handling", "probability": 0.84,
          "probabilities": { "missing_null_handling": 0.84, "wrong_return": 0.08, "boundary": 0.04 } },
"severity": { "level": "P2", "score": 1.4, "confidence": 0.38,
              "probabilities": { "0": 0.09, "1": 0.43, "2": 0.47, "3": 0.01 } }
```

## Reading a finding

A finding is an advisory drawn from a probability and a rule. It does not locate a
defect for you.

The number is belief. How bad the problem would be is a separate field. 72% means the
model would say yes about seven times in ten.

Probabilities spread across several kinds mean the model is sure something is wrong
and cannot say what. Say 0.4 on one kind and 0.3 on another. Read the method. Leave
the label alone.

The line it points at carries its own confidence. A low one puts the problem somewhere
in the method.

Expect the real problem to sit adjacent to what was reported. A `missing_null_handling`
at 70% is often an unchecked error a few lines off.

Answers below a question's `min` stay out of the report and stay in the JSON. A 56%
`has_bug` is worth a look while the report is silent about it.

Read the code before you change it. Close a finding when the code is right. Never
rewrite working code to satisfy a probability.

## Check one method

After a fix, ask about the thing you changed.

```console
$ perch check src/store.js::openStore.scanDir
src/store.js:74  openStore.scanDir
5 checks, 0 broken.

  Also raised: does_not_do_what_it_claims 80%
2 requests  5k tokens in / 767 out  $0.0002
```

`perch check src/store.js::openStore.scanDir --json` gives the same reading in full,
and an issue id works in place of a target.

This reads the file off disk, so it works on uncommitted code. It records nothing, so
it will not move the numbers on the issue you are fixing. It exits `3` while something
is still wrong.

## Read what CI found

A pull request scanned in CI has its results in Perch Cloud. Once `perch login` has
been run, read them instead of scanning again.

```console
$ perch ci
ID                                    Commit   Pull request  Result               When
043812ac-ea68-4c3b-88f0-737328f62826  5d7b033  #320          clean                23h ago
edf9f510-875c-44c8-8ff1-773e286be26e  a246d74  #320          clean                24h ago
6323adfc-9440-4640-badf-58c8e61cd5ba  d738e69  #320          4 problems, failing  45h ago
```

Those are the checked-out branch's runs, newest first, including any still going. Give
it a run ID for that run's issues, laid out the way `perch scan` prints them:

```console
$ perch ci 6323adfc-9440-4640-badf-58c8e61cd5ba
docs/coverage.md
  ID        Line  Severity  Type  Confidence  Problem                   Method
  8fd1e766     1  -         lint         72%  docs-sentences-are-short  docs/coverage.md

src/coverage.js
  ID        Line  Severity  Type    Confidence  Problem             Method
  8d9306ba   428  P1        defect         71%  wrong_return_value  askCoverage.<anonymous>.build
  7a5c2d1b   463  P1        defect         68%  wrong_return_value  askCoverage.<anonymous>.build#2

test/test-detection.test.js
  ID        Line  Severity  Type  Confidence  Problem                     Method
  69903bef     1  -         lint         61%  tests-assert-real-behavior  test/test-detection.test.…

✖ 4 problems in 3 files, failing
#320 at d738e69, finished 45h ago: https://dash.perchscan.com/#/scan/6323adfc-9440-4640-badf-58c8e61cd5ba
```

After a push, `perch ci --wait` waits for the run of the commit you are on and prints
what it found. A run exits the way a scan does: `3` when it found something that fails,
`1` when it could not finish.

On a pull request, each issue also says what became of Perch's review comment on it:
`open`, `resolved`, or `resolved by Perch` once a later scan stopped reporting it. The
replies are on the lines under it. Read them before changing the code, since a reviewer
may already have said why it is right.

Fix a CI issue the way you fix a local one. With `--json`, each issue carries the
`method` that `perch check` takes, so check it after the fix and push once it exits `0`.

`perch cloud` shows the workspace you are signed in to and how Perch Cloud scans this
repository's pull requests: whether it does, what it asks about, whether it reads the
changed code or the whole repository, and whether issues fail the Perch Scan check.
`perch cloud set` changes them with `--pull_requests`, `--scan_types`, `--scope` and
`--gate`. Change them only when the user asks.

`perch setup` also connects the assistant to Perch Cloud's MCP server, `perch-cloud`.
Its tools read and change the same things.

## Close a finding you have judged

```console
$ perch close 05a5b5bd --reason "the walk is one job read top to bottom"
05a5b5bd  scanRepository  src/scan.js:129  closed  too_big
```

A close covers the kinds the issue was listing. A different problem found on that
method later is still reported. `--kind too_big` closes one kind and leaves the rest
open.

Always give a reason. That is what the next person reads instead of reopening it.

## Check the tests a change needs

`perch coverage --since main` runs predictive mutation testing over the branch. It
mutates one line at a time in every method a test reaches and asks which tests would
fail against each mutant. It runs no tests and reads nothing a test run wrote.

```console
$ perch coverage --since main
src/cart.ts
  ID        Line  Problem   Confidence  Test or method  Note
  3945b1f7    12  survived         60%  applyDiscount   With `>` instead of `>=`, none of the 5 tests reaching it…
  d6f68653    12  survived         58%  applyDiscount   With `1` instead of `0`, none of the 5 tests reaching it …

test/cart.test.ts
  ID        Line  Problem    Confidence  Test or method              Note
  427fce7a    22  redundant         96%  applyDiscount > takes 75 …  Kills the same mutants as applyDiscount > ta…
shop at commit 861c607: 4 methods, 12 tests, 3 problems in changed code, 4 elsewhere
Report: .perch/coverage/index.html
14 requests  12k tokens in / 666 out  $0.0036
```

A `survived` mutant is a line the tests run but never check. `--json` gives each one
in full: the finding names its `mutant`, and the method's `mutants` entry with that id
has the line as written (`original`), as mutated (`mutated`), and the tests that were
asked (`asked`). Write a test in one of those test files with an input for which the
two lines give different results, and assert on the result. For `if (percent >= 100)`
against `if (percent > 100)`, that input is `percent` of exactly `100`.

A `redundant` test kills exactly the mutants an earlier test kills: compare the two
and delete one. `checks_nothing` kills no mutant in the code it reaches: make it
assert on what that code returns. `infra` calls a live service: mock it.

Run `perch coverage --since main` again afterwards; the mutant should be gone from the
list. It exits `3` while a problem remains in changed code. Close a problem with
`perch close <id> --reason "..."` when the test is right as it is.

## Write a rule when a mistake repeats

The second time the same thing is corrected, write it down. Ask the user before adding
a rule to their repository.

```console
$ perch rules add no-silent-failure --where "src/**/*.js" --each method \
    --ensure "Errors are returned or raised. Catching one, logging it, and carrying on as though it succeeded breaks this."
Added no-silent-failure.
```

`--where` takes a glob. `--each` is `file`, `method` or `test`. `--min N` sets a floor
for that rule alone. `--gate no` reports a rule without failing runs.

`--ensure_absent` is for a claim about the codebase as a whole. It searches the
likeliest places and stops at the answer.

Rules ride in the request perch was already making about a method. Five rules on one
method is one reading.

Say what breaks a rule and what satisfies it. A rule answering in the sixties about
everything cannot tell anything apart. Reword it or drop it. Raising its floor until
it keeps nothing is turning it off with extra steps.

`perch rules list` shows every rule and question in force, and whether each fails a run.

## Tune a rule until it tells two things apart

A rule is a sentence put to a model, so a new one is a draft. Test it against two
inputs before you trust it. One should pass. The other is a copy you broke in the way
the rule is meant to catch.

`perch check <path> --rules <name>` reads off disk and costs a fraction of a cent, so
the loop is fast.

The gap between the two readings is the rule's whole value. A rule that answers about
the same on both is measuring something other than what it says.

**Too broad.** A file rule worded as a universal gets you there. "Every sentence is
short" asks whether a counterexample exists anywhere in the file. Those odds rise with
the file's length whatever the prose does. Three rules written that way over this
project's docs ranked ten pages in almost exactly their line order. One page rewritten
entirely in 34-word run-ons read 92%. The same page in short sentences read 88%. Four
points between opposites.

**Too narrow.** Reworded to hunt the single longest sentence on a page, that rule
caught both broken controls. It also fired 80% on a clean page. On a long page there
is always some sentence to object to.

**The middle.** Name a bounded part of the file and judge only that. "Read the first
four prose paragraphs" and "find the first block that runs a real `perch` command"
both work. What they ask about does not grow with the page. The same three rules then
read 84%, 79% and 95% against their broken controls, and passed every clean page.

Aim for a gap that wide. A pass and a fail within a few points of each other means the
rule needs another pass.

## Other commands

| | |
| --- | --- |
| `perch doctor` | Whether perch can run here, and what the last run asked. |
| `perch issues --types` | Everything `--filter` accepts. |
| `perch --version` | The version in use. |
