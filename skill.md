---
name: perch
description: Semantic linting with perch. Use it to verify code changes in flight. Scan a branch or a diff. Check one method right after editing it. Confirm a fix landed before opening a pull request. Use it to lint behavior a compiler cannot check: bugs, vulnerabilities, swallowed errors, and a method that does not do what its name says. Use it to act on what a scan found. Use it to write rules that turn a repeated mistake into verifiable behavior.
---

# perch

perch asks a model about your code. It reports what it believes, as a probability on
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
`secret_exposure` is worth a look while the report is silent about it.

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

## Close a finding you have judged

```console
$ perch close 05a5b5bd --reason "the walk is one job read top to bottom"
05a5b5bd  scanRepository  src/scan.js:129  closed  too_big
```

A close covers the kinds the issue was listing. A different problem found on that
method later is still reported. `--kind too_big` closes one kind and leaves the rest
open.

Always give a reason. That is what the next person reads instead of reopening it.

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
