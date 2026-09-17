---
name: perch
description: Semantic linting with perch. Use when reviewing a branch or a diff, before a pull request, after changing code, or when asked to find bugs, vulnerabilities, swallowed errors or smells a compiler cannot catch. Also for acting on what a scan found, and for writing rules that stop a mistake recurring.
---

# perch

perch asks a model about your code and reports what it believes. Every finding is a probability, and most of what follows is
about what that means for how you use it.

## Scan what changed

```sh
perch scan --since origin/main --json
```

`--since <ref>` covers what moved since that ref, which is what you want on a branch and in CI. `--paths a,b` covers named files
or directories. Scanning a whole repository is hundreds of model requests where a branch is a handful, so never scan everything
to check one change. A method whose code and neighbours have not moved is not asked about again, so running the scan a second
time after a fix costs almost nothing.

A scan exits `0` when there is nothing to act on, `3` when it found something that fails, `1` when perch could not run, and `2`
when the command was typed wrong. `3` is a result rather than an error: report what it found. Only `1` and `2` are failures.

## Read the JSON

Every command takes `--json`. The table is rounded off for someone reading a terminal, and the JSON is where the detail is.

```sh
perch issues --json              # everything open, worst first
perch issues <id> --json         # one finding, in full
```

A reading carries every question's answer as a field, with the distribution behind it:

```json
"has_bug": 0.46,
"kind": { "choice": "missing_null_handling", "probability": 0.84,
          "probabilities": { "missing_null_handling": 0.84, "wrong_return": 0.08, "boundary": 0.04 } },
"severity": { "level": "P2", "score": 1.4, "confidence": 0.38,
              "probabilities": { "0": 0.09, "1": 0.43, "2": 0.47, "3": 0.01 } }
```

## What a finding claims

A finding is an advisory drawn from a probability and a rule. Not a located defect, and the difference matters.

The number is belief rather than severity: 72% means the model would say yes about seven times in ten, and how bad it would be is
a separate field. When the probabilities spread across several kinds, say 0.4 on one and 0.3 on another, the model is fairly sure
something is wrong and cannot tell you what, so read the method instead of fixing the label. The line it points at carries its own
confidence, and a low one means the problem is somewhere in the method rather than on that line. Expect the real problem to be
adjacent to what was reported: a `missing_null_handling` at 70% is often an unchecked error a few lines off. Answers below a
question's `min` are left out of the report and are still in the JSON, so a 56% `secret_exposure` is worth a look even when the
report is silent about it.

All of which is to say: read the code before you change it. If the code is right and the finding is wrong, close the finding.
Never rewrite working code to satisfy a probability.

## Check one method

After a fix, ask about the thing you changed rather than scanning again to find out.

```sh
perch check src/store.js::openStore.scanDir --json
perch check <issue-id> --json
```

This reads the file off disk rather than out of a commit, so it works on uncommitted code, and it records nothing, so it will not
move the numbers on the issue you are fixing. It exits `3` while something is still wrong.

## Close what is not a bug

```sh
perch close <id> --reason "a path the caller controls, on their own machine"
perch close <id> --kind too_big --reason "..."
```

A close covers the kinds the issue was listing, so a different problem found on that method later is still reported. `--kind`
closes one kind and leaves the rest open. Always give a reason, because that is what the next person reads instead of reopening
it.

## Write a rule when a mistake repeats

The second time the same thing is corrected, write it down so it is caught rather than remembered. Ask the user before adding a
rule to their repository.

```sh
perch rules add no-silent-failure --where "src/**/*.js" --each method \
  --ensure "Errors are returned or raised. Catching one, logging it, and carrying on as though it succeeded breaks this."
```

`--where` takes a glob, `--each` is `file`, `method` or `test`, `--min N` sets a floor for that rule alone, and `--gate no` says
to report it without failing runs. `--ensure_absent` is for a claim about the codebase rather than about every file: it searches
the likeliest places and stops at the answer. Rules ride in the request perch was already making about a method, so five rules on
one method is one reading rather than five.

Say what breaks a rule and not only what satisfies it. A rule that answers in the sixties about everything cannot tell anything
apart, and the fix is to reword it or drop it rather than raise its floor until it keeps nothing. `perch rules list` shows every
rule and question in force, and whether each one fails a run.

## Also

```sh
perch doctor          # whether perch can run here, and what the last run asked
perch issues --types  # everything --filter accepts
perch --version
```
