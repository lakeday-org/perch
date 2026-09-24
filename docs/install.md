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
it as `PERCH_API_KEY`:

```sh
export PERCH_API_KEY=<your TypeSafe API key>
```

To use another endpoint, see [Environment](/cli/#environment).

## The first scan

Run it at the root of the repository:

```console
$ perch scan
files.js
  ID        Line  Severity  Type      Confidence  Problem                Method
  623cd4c5     4  P0 (0.3)  security         89%  missing_authorization  readUpload
  623cd4c5     4  P0 (0.3)  defect           70%  unhandled_null         readUpload

cart.js
  ID        Line  Severity  Type    Confidence  Problem           Method
  450b87b4    18  P1 (1.5)  defect         80%  bad_state_change  removeItem

✖ 3 problems in 2 files, all failing
shop at commit 19ff8ea: 6 methods, read 6
6 requests  19k tokens in / 3k out  $0.0008
```

A large repository is hundreds of requests. `perch scan src` scans one directory.
