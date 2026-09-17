---
title: Quick start
nav: Quick start
group: Introduction
order: 2
summary: Install, set the key, scan, and read the first thing it found.
---

# Quick start

## What you need

Node 22 or newer, git, and a TypeSafe API key. perch reads the repository at
`HEAD`, so the directory you run it in has to be a git checkout.

## Install

```sh
npm install -g @lakeday/perch
```

Or run it without installing:

```sh
npx @lakeday/perch scan
```

## The key

`scan` and `check` call a model. Nothing else does.

```sh
export TYPESAFE_API_KEY=...
```

## The first scan

```sh
perch scan
```

It parses every tracked file, ranks the methods by risk, and reads them worst
first, walking out through callers and callees. It prints what it found grouped
by file, and a count at the end:

```console
src/graph.js
    41  buildGraph          P1 (1.1)  docs 78%, too_big 74%, type_confusion 67%
    18  resolveRust         -         docs 83%, no-silent-failure 56%
    59  buildGraph.sameDir  -         tangled_conditions 83%, docs 69%

! 18 problems in 14 places in 2 files
```

A first run over a large repository reads every method in scope, so narrow it
while you are getting a feel for it:

```sh
perch scan --paths src/graph.js
perch scan --since origin/main
```

## Reading what it found

`perch scan` reports by file. `perch issues` ranks across the whole repository,
worst first:

```console
$ perch issues
ID        Method             Location         Type      Kind                              Severity
723a2685  buildGraph         src/graph.js:41  docs      docs 78%, too_big 74%, +5 more    -
9a809860  resolveRust        src/graph.js:18  docs      docs 83%, +2 more                 -
763069db  buildGraph.sameD…  src/graph.js:59  refactor  tangled_conditions 83%, docs 69%  -
1-3 of 18 open issues. --page 2 for the next
```

The first column is the id. Give it to `perch issues` to open one up:

```sh
perch issues 723a2685
```

That prints everything perch answered about the method: the whole severity
distribution, every vulnerability class with its probability, which line the
defect points at and how confident that pick was, and which callers and callees
were in view when it read.

## Changing something and asking again

`perch check` puts the same questions to code as it reads on disk, uncommitted.
Nothing is recorded, so it is the one to run while you are working:

```sh
perch check 723a2685                          # whatever raised that issue
perch check src/graph.js::buildGraph          # a method, by name
perch check src/graph.js                      # a whole file
```

It exits 1 while something is still wrong, which is what a loop needs.

## Next

- [Reading issues](/issues/) for filtering and closing.
- [Your own rules](/rules/) to put your own questions in the same reading.
- [perch in CI](/ci/) for the pull request setup.
