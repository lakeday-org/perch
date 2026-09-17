---
title: Reading issues
nav: Reading issues
group: Using perch
order: 3
summary: The ranked list, what a row means, how to narrow it, and how to set aside what does not matter.
---

# Reading issues

`perch scan` reports by file, the way a linter does. `perch issues` ranks the
whole repository against itself, worst first.

```console
$ perch issues
ID        Method             Location         Type      Kind                              Severity
723a2685  buildGraph         src/graph.js:41  docs      docs 78%, too_big 74%, +5 more    -
684f145b  resolveModule      src/graph.js:32  lint      comment-says-why 75%, +2 more     -
0ec8fee7  buildGraph.lookup  src/graph.js:54  lint      no-silent-failure 68%, +1 more    -
1-3 of 18 open issues. --page 2 for the next
```

Ten rows by default. `--limit` changes that, `--page` moves through them, `--all`
prints every row.

## What a row means

One row is one method, not one problem. A method with a defect, a missing
comment and a refactor is one row carrying three issues.

| Column | |
| --- | --- |
| `ID` | Stable for as long as the method's source is unchanged. It is what `issues`, `check`, `close` and `reopen` take. |
| `Method` | The qualified name. Nested functions read as `buildGraph.lookup`. |
| `Location` | The file and the line. For a defect it is the line the model pointed at, not the method's first line. |
| `Type` | The class the row leads with: `defect`, `security`, `refactor`, `misaligned`, `docs`, or `lint`. |
| `Kind` | The issues themselves, likeliest first, with how sure perch is of each. |
| `Severity` | How much a caller would feel the defect. Empty when the row has no defect on it. |

Severity reads as a band and the number behind it, because the band alone throws
away how close the call was:

```
P1 (0.9)   almost P0
P1 (1.2)   settling toward P2
```

## One issue, opened up

```console
$ perch issues 723a2685
723a2685  buildGraph  src/graph.js:41-126  at commit 2bcd98b  read on 2026-09-17
Issues: docs 78%, too_big 74%, type_confusion 67%
Metrics: risk 74, maintainability 34, complexity 21, nesting 3, 59 lines; file risk 84
Defect: 44%. Points at line 60 (confidence 24%):
    60| for (const other of files) if (other !== file && dirname(other.path) === dirname(file.path)) …
Kind: unhandled_null 42%, wrong_return_value 28%, bad_state_change 10%, wrong_order 9%, off_by_one 8%
Severity: P1 (1.1) (P1 87%, P2 10%, P0 2%, P3 1%)
Exposed to outside input: 51%. Vulnerability: type_confusion 67%, resource_exhaustion 37%, …
Does what it claims: 80%. Misdocumented: 78%.
Called by: lintRepository, scanRepository, methodContext
Status: open
```

Everything perch answered is here, including answers below the floor. A defect at
44% is not listed on the table and is still printed here, because you asked about
this method specifically.

## Narrowing the list

`--filter` takes `type=`, `kind=` and `severity=`. Clauses on the same key are
alternatives, clauses on different keys all have to hold.

```sh
perch issues --filter type=security
perch issues --filter severity=P0,P1
perch issues --filter type=defect,security --filter kind=unhandled_null
```

`perch issues --types` prints every value the three keys accept.

A filtered list is ranked by what was filtered for rather than by overall weight,
so `--filter type=security` leads with the likeliest vulnerability in the
repository instead of whichever method is heaviest overall. Each row also
reorders to lead with the match.

## How sure perch has to be

An issue is listed when its probability is over 50 percent. Above a half is the
model saying yes; below it is the model saying no.

```sh
perch issues --min 80     # only what it is very sure of
perch issues --min 0      # everything it answered
```

The floor is on what gets claimed, not on the arithmetic. An issue at 49 percent
still weighs 0.49 in where its method sorts. See [the floor](/scan/#the-floor).

## Setting one aside

Not every finding is worth acting on. `perch close` takes one off the list:

```sh
perch close e585492e --reason "verifies the HMAC before parsing"
perch close 4eec00c0 7676ecad --reason "generated file"
```

The reason is kept and shown by `perch issues <id>`. A closure holds until you
take it back, the way a `.eslintignore` entry does, and later scans leave it
alone. `perch reopen <id>` puts it back.

```sh
perch issues --closed     # include what you set aside
```

Closed issues live in `.perch/closed.jsonl`, apart from the answers, because a
judgement you made has to survive the next run and an answer does not. Commit
that file if you want the team to share your dismissals.

## JSON

Every command takes `--json` and prints the same information for a script to
read:

```sh
perch issues --all --json | jq '.[] | select(.severity.mean > 2) | .path'
```
