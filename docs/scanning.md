---
title: Scanning your code
nav: Scanning your code
group: Using perch
order: 2.5
summary: Scan a repository, a directory, a file, or what a branch changed.
---

# Scanning your code

`perch scan` is the main command for finding problems in your code. It reads every method under the current directory, at
the commit you have checked out, and prints the problems it finds, grouped by file:

```console
$ perch scan
inventory.py
  ID        Line  Severity  Type    Confidence  Problem             Method
  0d0e3f8a     5  P1 (0.8)  defect         88%  wrong_return_value  reserve
  225c1645    21  P1 (0.7)  defect         93%  wrong_order         release_expired

checkout.py
  ID        Line  Severity  Type    Confidence  Problem             Method
  bdc67421    10  P1 (0.9)  defect         82%  wrong_order         place_order
  ddc5c917    21  P1 (0.9)  defect         94%  wrong_return_value  can_fulfil
  4f8bf5dc    29  P1 (0.8)  defect         68%  bad_state_change    refund

cart.py
  ID        Line  Severity  Type    Confidence  Problem             Method
  287bfb9d     7  P1 (1.1)  defect         93%  off_by_one          subtotal
  44c8d48a    21  P1 (1.0)  defect         74%  inverted_condition  is_eligible_for_free_shipping
  80d6ebbb    28  P1 (1.3)  defect         91%  unhandled_null      cheapest

storage.py
  ID        Line  Severity  Type    Confidence  Problem        Method
  5a623390    10  P1 (1.0)  defect         68%  error_ignored  load_order

✖ 9 problems in 4 files, all failing
order-service at commit b412add: 15 methods, read 15
15 requests  17k tokens in / 3k out  $0.0065
```

The last two lines show how many methods Perch read and what the requests cost. `perch scan` exits with code 0 when it
finds nothing, 3 when it reports a problem, and 1 when it can't complete the scan.

Note: `perch scan` only reads committed code. To check changes you haven't committed yet, use [`perch check`](/check/).

These are the most common ways to run it:

```sh
perch scan                          # Scan the current directory.
perch scan src/                     # Scan only files under src/.
perch scan --paths src,lib          # Scan files under src/ and lib/.
perch scan --since origin/main      # Scan only what changed since origin/main.
perch scan --filter type=security   # Ask only the security questions.
```

For the full list of options, run `perch scan --help`.

## Scan a directory or file

To scan part of a repository, pass a file or directory to `perch scan`:

```console
$ perch scan cart.py
cart.py
  ID        Line  Severity  Type    Confidence  Problem             Method
  287bfb9d     7  P1 (1.1)  defect         93%  off_by_one          subtotal
  44c8d48a    21  P1 (1.0)  defect         74%  inverted_condition  is_eligible_for_free_shipping
  80d6ebbb    28  P1 (1.3)  defect         91%  unhandled_null      cheapest

✖ 3 problems in 1 file, all failing
order-service at commit b412add: 4 methods, read 4
4 requests  0 tokens in  $0.0000
```

Perch only reports methods under the path you give it, but the model still sees their callers and callees from the rest
of the repository. In this example, the scan was free because the full scan above had already asked about these four
methods, and Perch Cloud returned the cached answers. To ignore the cache and ask again, use `--force`.

To scan more than one path, pass a comma-separated list to `--paths`:

```sh
perch scan --paths src,lib
```

## Scan changes on a branch

To scan only the files that changed on a branch, use `--since` with the branch or commit to compare against. This is the
scan you'll typically run on a pull request:

```console
$ perch scan --since origin/main
cart.py
  ID        Line  Severity  Type    Confidence  Problem             Method
  48a02173    15  P1 (1.0)  defect         88%  wrong_return_value  apply_discount
  44c8d48a    21  P1 (1.3)  defect         86%  inverted_condition  is_eligible_for_free_shipping
  80d6ebbb    28  P1 (1.3)  defect         91%  unhandled_null      cheapest

✖ 3 problems in 1 file, all failing
order-service at commit e648e44: 4 methods, read 3
3 requests  4k tokens in / 439 out  $0.0012
```

In this example, the branch fixed `subtotal` and changed how `apply_discount` calculates a discount. For each method the
diff touches, Perch sends the model the method's previous code and the diff, and asks whether the change introduced a
bug. Methods in the same file that the diff doesn't touch aren't checked again, but problems an earlier scan found in
them, such as the one in `cheapest`, are still reported.

Custom rules are checked for every method in the changed files. To run this scan on every pull request, see
[perch in CI](/ci/).

## Scan for security problems

By default, `perch scan` checks for bugs and custom rule violations. To check for something else, use `--filter`. For
example, `--filter type=security` asks only the security questions:

```console
$ perch scan --filter type=security
auth.py
  ID        Line  Severity  Type      Confidence  Problem                Method
  c3ff1609     7  P1 (0.8)  security         93%  weak_crypto            token_for
  c25aa687    12  P1 (0.6)  security         94%  missing_authorization  cancel_order

checkout.py
  ID        Line  Severity  Type      Confidence  Problem                 Method
  bdc67421    10  P1 (0.9)  security         80%  missing_authentication  place_order
  4f8bf5dc    29  P1 (0.8)  security         84%  missing_authentication  refund

✖ 4 problems in 2 files, all failing
order-service at commit b412add: 15 methods, read 15
15 requests  39k tokens in / 7k out  $0.03
```

Perch asks up to 30 security questions per method, so a security scan costs more than a default scan. To include security
checks in every scan, add `security` to [`scan_types`](/rules/#issue-types) in `perch.yaml`.

You can also use `--min` to report only problems above a confidence level. For example, `--min 80` reports only problems
Perch is at least 80% sure of. To print every answer as JSON, use `--json`.

## Ignore files

Perch automatically skips dependencies, build output and generated files. For the full list, see
[Ignored paths](/rules/#ignored-paths). To skip other files, add glob patterns to `ignore` in `perch.yaml`:

```yaml
ignore:
  - vendor/**
  - "**/*.generated.ts"
```

Paths that match `ignore` are skipped when you scan the whole repository. If you pass an ignored path directly, such as
`perch scan vendor/`, Perch scans it anyway.
