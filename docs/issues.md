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
ID        Method           Location         Type      Kind                                Severity
c3ff1609  token_for        auth.py:7        security  weak_crypto 94%                     P1 (0.7)
ddc5c917  can_fulfil       checkout.py:25   defect    does_not_do_what_it_claims 94%      P1 (0.9)
c25aa687  cancel_order     auth.py:12       security  missing_authorization 90%, +1 more  P0 (0.4)
287bfb9d  subtotal         cart.py:10       defect    off_by_one 89%                      P1 (1.1)
225c1645  release_expired  inventory.py:26  defect    bad_state_change 88%                P1 (0.9)
80d6ebbb  cheapest         cart.py:30       defect    unhandled_null 88%                  P2 (1.5)
0d0e3f8a  reserve          inventory.py:9   defect    wrong_return_value 87%              P1 (1.0)
bdc67421  place_order      checkout.py:15   defect    wrong_order 82%                     P1 (0.8)
5a623390  load_order       storage.py:15    defect    error_ignored 76%                   P1 (1.2)
4f8bf5dc  refund           checkout.py:31   defect    bad_state_change 74%                P1 (0.8)
1-10 of 12 open issues. --page 2 for the next
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
$ perch issues c25aa687
c25aa687  cancel_order  auth.py:12-16
44c53d9  read 2026-09-27  open

  Confidence  Type      Severity  Problem
         90%  security  P0 (0.4)  missing_authorization
         65%  defect    P0 (0.4)  unhandled_null

  Kind           unhandled_null 79%  bad_state_change 21%
  Severity       P0 76%  P1 11%  P3 7%  P2 6%
  Vulnerability  missing_authorization 90%  missing_authentication 90%  idor 85%  +18 more
  Claims         does what it claims 54%
  Code           risk 19  maintainability 71  complexity 1  nesting 0  5 lines
```

These are the columns the table prints, with every answer under them. The table
lists one vulnerability per method; `missing_authentication` at 90% is not a row,
and it is listed here.

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

An issue is listed when its score exceeds both its question's floor and the
run's `--min`. The default floor for both bug checks is 50 percent; see
[the question floors](/rules/#floors).

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
