---
name: perch
description: Semantic linting with perch. Use when reviewing a branch or a diff, before a pull request, after changing code, or when asked to find bugs, vulnerabilities, swallowed errors or smells a compiler cannot catch. Also for acting on what a scan found, and for writing rules that stop a mistake recurring.
---

# perch

perch asks a model about your code and reports what it believes. Every finding is a probability.

## Scan what changed

```sh
perch scan --since origin/main --json
```

- `--since <ref>` covers what moved since that ref. Use it on a branch and in CI.
- `--paths a,b` covers named files or directories.
- A repository is hundreds of requests. A branch is a handful. Never scan everything to check one change.
- Unchanged methods are not re-read, so running it again after a fix is nearly free.

Exit codes: `0` clean, `3` found something that fails, `1` perch could not run, `2` bad command.

**`3` is a result, not an error.** Report what it found. Only `1` and `2` are failures.

## Read the JSON

Every command takes `--json`. The table is rounded off for a terminal; the JSON has the distributions.

```sh
perch issues --json              # everything open, worst first
perch issues <id> --json         # one finding, in full
```

Each reading carries every answer as a field:

```json
"has_bug": 0.46,
"kind": { "choice": "missing_null_handling", "probability": 0.84,
          "probabilities": { "missing_null_handling": 0.84, "wrong_return": 0.08, "boundary": 0.04 } },
"severity": { "level": "P2", "score": 1.4, "confidence": 0.38,
              "probabilities": { "0": 0.09, "1": 0.43, "2": 0.47, "3": 0.01 } }
```

## What a finding claims

An advisory from a probability and a rule. Not a located defect.

The number is belief, not severity: 72% means yes about seven times in ten, and severity is its own field. When `probabilities`
spreads across several kinds, 0.4 on one and 0.3 on another, something is wrong and the model cannot say what; read the method
rather than fixing the label. The line carries its own confidence, and a low one puts the problem somewhere in the method instead
of on that line. Expect it to be adjacent: a `missing_null_handling` at 70% is often an unchecked error a few lines off. Answers
below a question's `min` are absent from the report and present in the JSON.

Read the code before changing it. If the code is right, close the finding. Never rewrite working code to satisfy a probability.

## Check one method

After a fix, ask about what you changed. Do not rescan.

```sh
perch check src/store.js::openStore.scanDir --json
perch check <issue-id> --json
```

Reads the file off disk, so it works on uncommitted code. Records nothing, so it does not move the numbers on the issue you are
fixing. Exits `3` while something is still wrong.

## Close what is not a bug

```sh
perch close <id> --reason "a path the caller controls, on their own machine"
perch close <id> --kind too_big --reason "..."
```

A close covers the kinds the issue listed, so a different problem found later still reports. `--kind` closes one and leaves the
rest. Always give a reason.

## Write a rule when a mistake repeats

The second time the same thing is corrected, put it where it is caught instead of remembered. **Ask the user first.**

```sh
perch rules add no-silent-failure --where "src/**/*.js" --each method \
  --ensure "Errors are returned or raised. Catching one, logging it, and carrying on as though it succeeded breaks this."
```

- `--where` a glob, `--each file|method|test`, `--min N` a floor for that rule, `--gate no` to report without failing runs.
- `--ensure_absent` searches the likeliest places and stops at the answer, for a claim about the codebase rather than every file.
- Rules ride in the request perch was already making, so five rules on a method is one reading.
- Say what breaks the rule, not only what satisfies it. A rule answering in the sixties about everything tells nothing apart:
  reword it or drop it rather than raising its floor until it keeps nothing.
- `perch rules list` shows every rule in force and whether each fails a run.

## Also

```sh
perch doctor          # whether perch can run, what the last run asked
perch issues --types  # what --filter accepts
perch --version
```
