---
name: perch
description: Semantic linting with perch. Use when reviewing a branch or a diff, before opening a pull request, after writing or changing code, or when asked to look for bugs, security problems, swallowed errors or code smells that a compiler and a linter cannot catch. Also for acting on what a perch scan already found, and for writing project rules that keep a mistake from coming back.
---

# perch

perch reads code with a model and reports what it believes about it. Every finding is a probability. Nothing it says is a fact
about your program, and the workflow below exists because of that.

## Scan what changed

Narrow every run. A whole repository is hundreds of model requests; a branch is a handful.

```sh
perch scan --since origin/main --json
```

- `--since <ref>` covers what moved since that ref. This is what you want on a branch and in CI.
- `--paths a,b` covers named files or directories.
- A method whose code, neighbours and questions are unchanged is not asked about again, so scanning again after a fix is nearly
  free. You do not need to avoid re-running it.

Exit codes: `0` nothing to act on, `3` it found something that fails, `1` perch could not run, `2` the command was typed wrong.
**`3` is a result, not an error.** Only `1` and `2` mean something went wrong.

## Read the JSON

Every command takes `--json`, and that is where the detail is. The table rounds everything off for a human reading a terminal.

```sh
perch issues --json              # everything open, worst first
perch issues <id> --json         # one finding, in full
perch scan --since origin/main --json
```

A reading carries every question's answer as a field, with the whole distribution:

```json
"has_bug": 0.46,
"kind": { "choice": "missing_null_handling", "probability": 0.84,
          "probabilities": { "missing_null_handling": 0.84, "wrong_return": 0.08, "boundary": 0.04 } },
"severity": { "level": "P2", "score": 1.4, "confidence": 0.38,
              "probabilities": { "0": 0.09, "1": 0.43, "2": 0.47, "3": 0.01 } }
```

The table would have shown you `P2` and a percentage. The JSON shows you how close the call was.

## What a finding actually claims

A finding is an advisory drawn from a probability and a rule, not a located defect. Read it that way:

- **The number is belief, not severity.** 72% means the model would answer yes about seven times in ten. Severity is its own
  question, in its own field.
- **A spread distribution means it does not know which.** If `kind.probabilities` puts 0.4 on one kind and 0.3 on another, the
  model is fairly sure something is wrong and unsure what. Read the method; do not fix the label.
- **The line is a guess and says so.** `perch issues <id> --json` gives the line it points at with its own confidence. A low one
  means the problem is somewhere in the method rather than on that line.
- **The real problem is often adjacent.** A `missing_null_handling` at 70% is frequently an unchecked error a few lines away.
  Treat the label as where to look, not what to change.
- **Under a floor is not nothing.** Each question carries a `min`; answers below it are not listed, but they are in the JSON. A
  56% `secret_exposure` is worth a glance even though the report is silent about it.

So read the code before changing it. If the code is right and the finding is wrong, close it with a reason. Do not rewrite
working code to satisfy a probability.

## Check one method, not the repository

After a fix, ask about the one thing you changed. Do not rescan to find out.

```sh
perch check src/store.js::openStore.scanDir --json
perch check <issue-id> --json
```

- `path::method` asks about that method alone: every rule covering it, plus the scan's own questions.
- An issue id asks about the method that issue is on.
- It reads the file **off disk**, not out of a commit, so it works on uncommitted work.
- Nothing is recorded, so it does not move the numbers on the issue you are fixing. Run it as often as you like.
- Exits `3` while something is still wrong, `0` when it is clean.

## Close what is not a bug

```sh
perch close <id> --reason "a path the caller controls, on their own machine"
perch close <id> --kind too_big --reason "..."
perch reopen <id>
```

A close covers the kinds the issue was listing, so a different problem found on that method later is still reported. `--kind`
closes one kind and leaves the rest open. Always give a `--reason`: it is what the next person reads instead of reopening it.

## Turn a repeated mistake into a rule

When the same problem appears twice, or the user corrects the same thing twice, write it down so it is caught rather than
remembered. **Ask the user before adding a rule to their repository.**

```sh
perch rules add no-silent-failure --where "src/**/*.js" --each method \
  --ensure "Errors are returned or raised. A method that catches one, logs it, and carries on as though it succeeded breaks this."
```

- `--where` a glob, `--each file|method|test`, `--min N` a floor for this rule alone, `--gate no` to report without failing runs.
- `--ensure_absent` for a claim about the codebase rather than about every file: it searches the likeliest places and stops at the
  answer, which costs a fraction of a sweep.
- Rules ride in the request perch was already making about that method, so five rules on one method is one reading, not five.
- Say what **breaks** the rule, not only what satisfies it. A rule that answers in the sixties about everything cannot tell
  anything apart; reword it or remove it rather than raising its floor until it keeps nothing.
- `perch rules list` shows every rule and question in force, including perch's own, and whether each one fails a run.

## The rest

```sh
perch doctor          # whether perch can run here, and what the last run did and asked
perch issues --types  # everything --filter accepts
perch --version
```
