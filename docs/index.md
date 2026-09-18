---
title: perch
nav: Introduction
group: Introduction
order: 1
summary: A linter that reads meaning. It finds the bugs a parser cannot prove are there.
---

# perch

perch is a linter that reads meaning. A linter matches patterns in a syntax tree, so it
finds what somebody wrote a pattern for. perch reads each method the way a reviewer
would, with its callers and callees in front of it.

```console
$ perch scan
src/store.js
  ID        Line  Severity  Type      Confidence  Problem             Method
  d8f67bd9    46  -         refactor         72%  tangled_conditions  closures
  463c56ed    63  -         refactor         74%  too_big             openStore

src/git.js
  ID        Line  Severity  Type    Confidence  Problem           Method
  fe166264    84  P1 (1.3)  defect         72%  integer_overflow  readBlobs

✖ 3 problems in 2 files, 1 failing
perch at commit d4f7adf: 38 methods, read 38
110 requests  81k tokens in / 5k out  $0.0034
```

Every answer is a probability. `72%` is how sure perch is, and it stays on the row.

## Install

```sh
npm install -g @lakeday/perch
export TYPESAFE_API_KEY=...
```

Needs Node 22 and git.

## The questions it asks

Each method gets the same set. Is there a bug, where, what kind, how bad. Is it a
security hole. Does it do what its name says. Does it need refactoring.

A method is ranked by what its problems would cost, not by how many it has. The list
runs worst first.

## Your own rules

Rules live in `perch.yaml` and are sentences:

```yaml
- name: no-silent-failure
  where: "src/**/*.js"
  each: method
  ensure: An error is returned or raised, never swallowed into a log.
```

They ride in the request perch was already making about that method. Five rules on one
method is one reading, not six.

## What it writes

Nothing in your working tree. Results go to `.perch`:

| File | What it holds |
| --- | --- |
| `.perch/scan.jsonl` | What the last run found. Rewritten whole every run. |
| `.perch/closed.jsonl` | What you set aside with `perch close`. Survives the next run. |

`--out` points them somewhere else.
