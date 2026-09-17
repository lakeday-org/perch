---
title: perch
nav: Introduction
group: Introduction
order: 1
summary: A model reads every method in your repository, answers the same set of questions about each one, and the answers come back as probabilities.
---

# perch

perch finds bugs and design problems in a repo.

`perch scan` parses every tracked file with tree-sitter, scores each method, then
asks a TypeSafe System One model a fixed set of questions about each one: is
there a bug, where is it, what kind, how bad, is it a security hole, does it do
what its name says, does it need refactoring.

Answers come back as probabilities, not verdicts. A method is ranked by what its
problems would cost rather than by how many it has, and the list is sorted worst
first.

```sh
npm install -g @lakeday/perch
export TYPESAFE_API_KEY=...
perch scan
perch issues
```

## What makes it different from a linter

A linter matches patterns in a syntax tree, so it can only find what somebody
wrote a pattern for. perch reads the method the way a reviewer would, with its
callers and callees in front of it, and answers questions about meaning: does
this off-by-one matter to anyone who calls it, does this comment describe what
the code actually does, does this caller violate the contract of the thing it
calls.

That also means the answers are probabilities. An issue is listed when perch is
more than half sure of it, and the number stays on the row so you can see how
sure. See [the floor](/scan/#the-floor).

## What it costs to run

One HTTP request per method. System One does not bill output tokens, so asking
thirty questions of a method costs what asking one costs, which is why the set of
questions is wide rather than staged.

Rules you write in `perch.yaml` are asked in the same request as perch's own
questions, so a method covered by five rules is one reading, not six.

## What it writes

Nothing in your working tree. Results go to `.perch`, which you can point
somewhere else with `--out`:

| File | What it holds |
| --- | --- |
| `.perch/scan.jsonl` | What the last run found, one line per method read and per rule broken. Rewritten whole every run. |
| `.perch/closed.jsonl` | What you set aside with `perch close`, which has to survive the next run. |

## Where to go next

- [Quick start](/install/) installs it and walks the first scan.
- [Reading issues](/issues/) is the list, the filters, and closing what does not matter.
- [Semantic linting](/rules/) is `perch.yaml`.
- [How a scan works](/scan/) is the graph walk, the questions, and the arithmetic behind the ranking.
