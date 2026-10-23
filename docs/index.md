---
title: perch
nav: Introduction
group: Getting started
order: 1
summary: Semantic code and security scanner.
---

# perch

Perch is a semantic code and security scanner. It finds bugs, security vulnerabilities and violations of your own rules by
asking a language model about each method in your repository, with the method's callers and callees included for context.

For example, running `perch scan` in a small Python project produces output like this:

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

The Confidence column is the model's estimated probability that the problem is real. The Severity column estimates how
badly the problem would affect callers, from P0 (most severe) to P3. `perch scan` exits with code 3 when it reports a
problem, so you can use it to fail a CI build.

## Installation

Perch requires Node.js 22 or later and git. Install it with npm, then sign in to Perch Cloud:

```sh
npm install -g @lakeday/perch
perch login
```

By default, Perch sends its questions to a model through Perch Cloud, which bills your organization for usage. You can
also use your own model endpoint. See [Quick start](/install/) for details.

## Default checks

By default, `perch scan` asks two questions about every method: whether it contains a functional bug, and whether it
mishandles an empty value, a boundary value or an alternate branch. The same request also asks which kind of bug is most
likely and how severe it would be.

Security, refactoring and documentation checks are turned off by default. To turn them on for every scan, add them to
`scan_types` in `perch.yaml`. To run them for a single scan, use `--filter`:

```sh
perch scan --filter type=security
```

## Custom rules

You can also write your own rules in `perch.yaml`. A rule is a plain-English statement that your code should satisfy. For
example:

```yaml
- name: errors-reach-the-caller
  where: "**/*.py"
  each: method
  min: 65
  ensure: >-
    When this method catches an exception, it raises it again or returns a value
    the caller can tell apart from success. Logging the exception and returning
    an ordinary value breaks this rule.
```

In this example, Perch checks every method in every Python file and reports methods that catch an exception and hide it
from the caller. Custom rules are checked in the same request as Perch's built-in questions, so adding rules doesn't
increase the number of requests. To learn how to write rules, see [Semantic linting](/rules/).

## The .perch directory

Perch stores scan results in a `.perch` directory at the root of your repository:

| Path | Contents |
| --- | --- |
| `.perch/scan.jsonl` | The results of the last scan. Each scan replaces this file. |
| `.perch/closed.jsonl` | Issues you closed with `perch close`, and your reasons. Commit this file. |
| `.perch/rules/` | Optional rule files, if you split your rules out of `perch.yaml`. Commit these files. |

Commands like `perch issues` read from these files, so they work offline and don't make any requests. To store results in
a different directory, use `--out DIR`.
