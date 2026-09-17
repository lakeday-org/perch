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
ID        Method             Location           Type      Kind                              Severity
3a7c6bfe  build              …ts/build.mjs:183  refactor  too_big 99%, +3 more              P1 (1.4)
1f235668  docPage            …pts/build.mjs:82  docs      docs 81%, too_big 77%, +1 more    P1 (1.3)
eb9dfee4  versionAssets      …ts/build.mjs:161  security  resource_exhaustion 80%, +2 more  P1 (1.3)
1-3 of 27 open issues. --page 2 for the next
```

Ten rows by default. `--limit` changes that, `--page` moves through them, `--all`
prints every row.

## What a row means

One row is one method, not one problem. A method with a defect, a missing
comment and a refactor is one row carrying three issues.

| Column | |
| --- | --- |
| `ID` | Stable for as long as the method's source is unchanged. It is what `issues`, `check`, `close` and `reopen` take. |
| `Method` | The qualified name. Nested functions read as `versionAssets.walk`. |
| `Location` | The file and the line. For a defect it is the line the model pointed at, not the method's first line. |
| `Type` | The class the row leads with: `defect`, `security`, `refactor`, `misaligned`, `docs`, or `lint`. |
| `Kind` | The issues themselves, likeliest first, with how sure perch is of each. |
| `Severity` | How much a caller would feel it. Empty on a row carrying neither a defect nor a vulnerability, since those are the two the rubric weighs. |

Severity reads as a band and the number behind it, because the band alone throws
away how close the call was:

```
P1 (0.9)   almost P0
P1 (1.2)   settling toward P2
```

The band is `round(mean)` and the number is `3 − mean`, over a distribution the
model gives across all four levels. [How a scan works](scan.md) works it through.

## One issue, opened up

```console
$ perch issues 723a2685
723a2685  buildGraph  src/graph.js:41-126
01b4aff  read 2026-09-17  open

  Sure  Type      Severity  Problem
   80%  refactor  -         too_big
   75%  docs      -         docs
   68%  security  P1 (1.1)  type_confusion
   55%  lint      -         no-legacy-fallback

     84  const link = (map, from, to) => { if (!map.has(from)) map.set(from, new Set()); map.get(from).add(to); };
         the line it points at, 24% sure

  Kind           unhandled_null 44%  wrong_return_value 24%  bad_state_change 12%  +4 more
  Severity       P1 83%  P2 12%  P0 4%  P3 1%
  Exposed        44%
  Vulnerability  type_confusion 68%  uninitialized_use 34%  resource_exhaustion 33%  +13 more
  Claims         does what it claims 80%  misdocumented 75%
  Refactor       too_big 80%  tangled_conditions 16%  +2 more
  Calls          buildGraph.resolve  buildGraph.link  buildGraph.callees  buildGraph.callers  resolveRust.has
  Called by      lintRepository  scanRepository  methodContext
  Code           risk 74  maintainability 34  complexity 21  nesting 3  59 lines
```

The same columns the table prints, with what was asked under them. Everything
perch answered is here, including answers below the floor: a defect at 44% is
not a row on the table and is still printed here, because you asked about this
method.

The `Severity` column is on the rows the rubric weighs, which are the defect and
the vulnerability. The block below it is the same question's whole distribution,
which is what the band and the number in brackets are worked out from.

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
