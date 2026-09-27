---
title: Scanning your code
nav: Scanning your code
group: Using perch
order: 2.5
summary: Scan a repository, a directory, a file, or what a branch changed.
---

# Scanning your code

`perch scan` reads every method under the directory you run it in and prints what it found, file by file:

```console
$ perch scan
cart.py
  ID        Line  Severity  Type    Confidence  Problem                     Method
  287bfb9d    10  P1 (1.0)  defect         89%  off_by_one                  subtotal
  48a02173    17  P1 (1.3)  defect         74%  off_by_one                  apply_discount
  44c8d48a    23  P1 (1.1)  defect         71%  does_not_do_what_it_claims  is_eligible_for_free_sh…
  80d6ebbb    30  P2 (1.5)  defect         88%  unhandled_null              cheapest

inventory.py
  ID        Line  Severity  Type    Confidence  Problem             Method
  0d0e3f8a     9  P1 (1.0)  defect         87%  wrong_return_value  reserve
  225c1645    26  P1 (1.0)  defect         88%  bad_state_change    release_expired

storage.py
  ID        Line  Severity  Type    Confidence  Problem        Method
  5a623390    15  P1 (1.3)  defect         76%  error_ignored  load_order

checkout.py
  ID        Line  Severity  Type    Confidence  Problem                     Method
  bdc67421    15  P1 (0.8)  defect         82%  wrong_order                 place_order
  ddc5c917    25  P1 (0.9)  defect         94%  does_not_do_what_it_claims  can_fulfil
  4f8bf5dc    31  P1 (0.8)  defect         74%  bad_state_change            refund

auth.py
  ID        Line  Severity  Type    Confidence  Problem         Method
  c25aa687    14  P1 (0.5)  defect         65%  unhandled_null  cancel_order

✖ 11 problems in 5 files, all failing
order-service at commit 44c53d9: 14 methods, read 14
14 requests  17k tokens in / 3k out  $0.0007
```

The last two lines count the methods read and what the requests cost. The scan exits 3 when it finds something that
fails and 0 when it finds nothing.

## A directory or a file

Name a path to scan part of the repository:

```console
$ perch scan cart.py
cart.py
  ID        Line  Severity  Type    Confidence  Problem                     Method
  287bfb9d    10  P1 (1.1)  defect         89%  off_by_one                  subtotal
  48a02173    17  P1 (1.3)  defect         74%  off_by_one                  apply_discount
  44c8d48a    23  P1 (1.1)  defect         79%  does_not_do_what_it_claims  is_eligible_for_free_sh…
  80d6ebbb    30  P2 (1.5)  defect         89%  unhandled_null              cheapest

✖ 4 problems in 1 file, all failing
order-service at commit 44c53d9: 4 methods, read 4
4 requests  5k tokens in / 921 out  $0.0002
```

Only methods under the path are read and reported. Their callers and callees elsewhere in the repository are still
shown to the model.

`--paths` takes several at once:

```sh
perch scan --paths src,lib
```

## What a branch changed

`--since` reads only the files that changed since a branch or commit:

```console
$ perch scan --since origin/main
cart.py
  ID        Line  Severity  Type    Confidence  Problem         Method
  287bfb9d    10  P1 (1.1)  defect         89%  off_by_one      subtotal
  48a02173    17  P1 (1.4)  defect         71%  off_by_one      apply_discount
  80d6ebbb    30  P1 (1.4)  defect         89%  unhandled_null  cheapest

✖ 3 problems in 1 file, all failing
order-service at commit 6b1cce2: 5 methods, read 5
5 requests  6k tokens in / 1k out  $0.0002
```

This is the scan to run on a pull request. [perch in CI](/ci/) has the jobs.

## One kind of problem

`--filter` reports one type, kind or severity. A scan asks about defects and rules by default, and
`--filter type=security` asks about vulnerabilities as well:

```console
$ perch scan --filter type=security
auth.py
  ID        Line  Severity  Type      Confidence  Problem                Method
  c3ff1609     7  P1 (0.7)  security         94%  weak_crypto            token_for
  c25aa687    12  P0 (0.4)  security         90%  missing_authorization  cancel_order

✖ 2 problems in 1 file, all failing
order-service at commit 44c53d9: 14 methods, read 14
14 requests  33k tokens in / 8k out  $0.0014
```

`--min 80` hides anything perch is less than 80% sure of. `--json` prints every answer instead of the table.

## Files to skip

Paths under `ignore` in `perch.yaml` are skipped when you scan the repository:

```yaml
ignore:
  - vendor/**
  - "**/*.generated.ts"
```

Naming an ignored path reads it anyway, so `perch scan vendor/` scans `vendor`.
Dependencies and build output are skipped without being listed.
