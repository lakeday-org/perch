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
ID        Method        Location    Type      Kind                                Severity
623cd4c5  readUpload    files.js:4  security  missing_authorization 90%, +1 more  P0 (0.3)
450b87b4  removeItem    cart.js:18  defect    bad_state_change 79%                P1 (1.4)
f5e6b16e  averagePrice  cart.js:13  defect    unhandled_null 61%                  P2 (1.7)
3 open issues
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
| `Severity` | How bad it would be for a caller. The rubric grades the defect and the vulnerability, so other rows are empty. |

Severity prints as a band and a number, `P1 (0.9)`. The number is where it falls
within the band:

```
P1 (0.9)   almost P0
P1 (1.2)   settling toward P2
```

The band is `round(mean)` and the number is `3 − mean`, over a distribution the
model gives across all four levels. [Inside a scan](scan.md) works it through.

## One issue in full

```console
$ perch issues 623cd4c5
623cd4c5  readUpload  files.js:4-6
19ff8ea  read 2026-09-24  open

  Confidence  Type      Severity  Problem
         90%  security  P0 (0.3)  missing_authorization
         71%  defect    P0 (0.3)  unhandled_null

      5  return readFileSync(join('/srv/uploads', name), 'utf8');
         the line it points at, 98% sure

  Kind           unhandled_null 66%  off_by_one 23%  wrong_return_value 7%  +4 more
  Severity       P0 84%  P1 7%  P3 5%  P2 4%
  Exposed        95%
  Vulnerability  missing_authorization 90%  path_traversal 86%  injection 77%  +7 more
  Claims         does what it claims 77%
  Code           risk 15  maintainability 77  complexity 1  nesting 0  3 lines
```

These are the columns the table prints, with every answer under them. The table
lists one vulnerability per method; `path_traversal` at 86% is not a row, and it
is listed here.

`Severity` is filled in on the two rows the rubric weighs, the defect and the
vulnerability. The `Severity` line lower down carries the whole distribution, and
the band and bracketed number are worked out from it.

## Filters

`--filter` takes `type=`, `kind=`, `severity=` and `rule=`. Clauses on the same
key are alternatives, clauses on different keys all have to hold.

```sh
perch issues --filter type=security
perch issues --filter severity=P0,P1
perch issues --filter type=defect,security --filter kind=unhandled_null
perch issues --filter rule=no-silent-failure
```

`perch issues --types` prints every value the three keys accept.

A filtered list is ranked by what was filtered for, so `--filter type=security`
puts the likeliest vulnerability first. Each row shows the matching issue first
as well.

## Floors

An issue is listed when its probability is over 50 percent.

```sh
perch issues --min 80     # only what it is very sure of
perch issues --min 0      # everything it answered
```

The floor decides what is listed. The ranking uses every answer, so an issue at
49 percent still weighs 0.49 in where its method sorts. See [the floor](/scan/#the-floor).

## Closing an issue

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

Closed issues live in `.perch/closed.jsonl`.

## JSON

Every command takes `--json` and prints the same information for a script to
read:

```sh
perch issues --all --json | jq '.[] | select(.severity.mean > 2) | .path'
```
