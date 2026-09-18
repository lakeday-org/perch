---
title: Reading issues
nav: Reading issues
group: Using perch
order: 3
summary: The ranked list, what a row means, and how to narrow it.
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

## The columns

One row is one method. A method with a defect, a missing comment and a refactor
is one row carrying three issues.

| Column | |
| --- | --- |
| `ID` | Stable while the method's source is. What `issues`, `check`, `close` and `reopen` take. |
| `Method` | The qualified name. Nested functions read as `versionAssets.walk`. |
| `Location` | The file and the line. For a defect, the line the model pointed at. |
| `Type` | The class the row leads with: `defect`, `security`, `refactor`, `docs`, or `lint`. |
| `Kind` | The issues themselves, likeliest first, with how sure perch is of each. |
| `Severity` | How much a caller would feel it. Empty on a row carrying neither a defect nor a vulnerability, since those are the two the rubric weighs. |

Severity prints as a band and a number, `P1 (0.9)`. The number says where in the
band the row sits:

```
P1 (0.9)   almost P0
P1 (1.2)   settling toward P2
```

The band is `round(mean)` and the number is `3 − mean`, over a distribution the
model gives across all four levels. [Inside a scan](scan.md) works it through.

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
  Claims         does what it claims 80%  documented 25%
  Refactor       too_big 80%  tangled_conditions 16%  +2 more
  Calls          buildGraph.resolve  buildGraph.link  buildGraph.callees  buildGraph.callers  resolveRust.has
  Called by      lintRepository  scanRepository  methodContext
  Code           risk 74  maintainability 34  complexity 21  nesting 3  59 lines
```

These are the columns the table prints, with every answer under them. That
includes answers below the floor. A defect at 44% is left off the table, and
`perch issues <id>` still shows it.

`Severity` is filled in on the two rows the rubric weighs, the defect and the
vulnerability. The `Severity` line lower down carries the whole distribution, and
the band and bracketed number are worked out from it.

## Narrowing the list

`--filter` takes `type=`, `kind=`, `severity=` and `rule=`. Clauses on the same
key are alternatives, clauses on different keys all have to hold.

```sh
perch issues --filter type=security
perch issues --filter severity=P0,P1
perch issues --filter type=defect,security --filter kind=unhandled_null
perch issues --filter rule=no-silent-failure
```

`perch issues --types` prints every value the three keys accept.

A filtered list is ranked by what was filtered for. So `--filter type=security`
leads with the likeliest vulnerability in the repository. Each row also reorders
to lead with the match.

## Floors

An issue is listed when its probability is over 50 percent.

```sh
perch issues --min 80     # only what it is very sure of
perch issues --min 0      # everything it answered
```

The floor decides what gets claimed. The ranking still uses every answer, so an
issue at 49 percent weighs 0.49 in where its method sorts. See [the floor](/scan/#the-floor).

## Setting one aside

`perch close` takes a finding off the list:

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

Closed issues live in `.perch/closed.jsonl`, apart from the answers. A judgement
you made has to survive the next run. Commit that file to share dismissals
with the team.

## JSON

Every command takes `--json` and prints the same information for a script to
read:

```sh
perch issues --all --json | jq '.[] | select(.severity.mean > 2) | .path'
```
