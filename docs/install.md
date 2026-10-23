---
title: Quick start
nav: Quick start
group: Getting started
order: 2
summary: Install Perch, sign in, and run your first scan.
---

# Quick start

## Prerequisites

To use Perch, you need Node.js 22 or later and git. Perch scans the commit that is currently checked out, so you need to
run it inside a git repository.

## Install Perch

Install Perch globally with npm:

```sh
npm install -g @lakeday/perch
```

To run Perch without installing it, use `npx @lakeday/perch` in place of `perch`. For example, `npx @lakeday/perch scan`.

## Sign in to Perch Cloud

Run `perch login` to sign in. Perch prints a link and a confirmation code:

```console
$ perch login
Open https://dash.perchscan.com/device?code=L9DR-8BTD
Confirm code: L9DR-8BTD
```

Open the link in your browser and confirm the code. Perch saves your login to `~/.perch/cloud.json`, outside your
repository, and uses it for every command that needs it.

New accounts include $5 of free usage. Perch Cloud caches answers for each repository, so scanning code that hasn't
changed is free.

## Run your first scan

Navigate to the root of your repository and run `perch scan`:

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

Perch makes at least one request per method, so scanning a large repository can take hundreds of requests. To scan only
part of a repository, pass a directory, such as `perch scan src`. For other ways to narrow a scan, see
[Scanning your code](/scanning/).

## Use your own model endpoint

If you don't want to use Perch Cloud, you can send Perch's questions directly to a model provider. Set `PERCH_BASE_URL`
to the provider's endpoint and `PERCH_API_KEY` to your API key:

```sh
export PERCH_BASE_URL=https://api.typesafe.ai/v1/systemone
export PERCH_API_KEY='paste-your-TypeSafe-key-here'
```

When `PERCH_BASE_URL` is set, Perch ignores your Perch Cloud login. For the list of supported endpoints, see
[Environment](/cli/#environment).
