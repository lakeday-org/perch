---
title: Quick start
nav: Quick start
group: Getting started
order: 2
summary: Install perch, set the key, and run the first scan.
---

# Quick start

## Requirements

- Node 22 or newer
- git
- An API key for your endpoint

perch reads the repository at `HEAD`, so run it inside a git checkout.

## Install

```sh
npm install -g @lakeday/perch
```

Or run it without installing:

```sh
npx @lakeday/perch scan
```

## The key

Create an API key at [console.typesafe.ai](https://console.typesafe.ai) and set
the full System One request URL and your key:

```sh
export PERCH_BASE_URL=https://api.typesafe.ai/v1/systemone
export PERCH_API_KEY='paste-your-TypeSafe-key-here'
```

Liquid AI's decision models use the same format; [Environment](/cli/#environment) shows how to
point perch at them or at another endpoint.

## The first scan

Run it at the root of the repository:

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

A large repository is hundreds of requests. `perch scan src` scans one directory.
