---
title: Quick start
nav: Quick start
group: Getting started
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

`scan` and `check` are the two commands that call a model.

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
$ perch scan
src/store.js
  ID        Line  Severity  Type      Confidence  Problem             Method
  d8f67bd9    46  -         refactor         72%  tangled_conditions  closures
  463c56ed    63  -         refactor         74%  too_big             openStore
  67defb37   134  -         refactor         73%  tangled_conditions  openStore.decide

src/checks.js
  ID        Line  Severity  Type      Confidence  Problem  Method
  90e449ae    27  -         refactor         68%  too_big  runChecks

! 5 problems in 2 files, none failing
perch at commit d4f7adf: 38 methods, read 2, 38 unchanged
110 requests  81k tokens in / 5k out  $0.0034
```

A method whose code, whose neighbours and whose questions are all unchanged since
the last run is not read again, which is what `38 unchanged` counts.

A first run over a large repository reads every method in scope, so narrow it
while you are getting a feel for it:

```sh
perch scan --paths src
perch scan --since origin/main
```

## Reading what it found

`perch scan` reports by file. `perch issues` ranks across the whole repository,
worst first:

```console
$ perch issues
ID        Method             Location           Type      Kind                              Severity
3a7c6bfe  build              …ts/build.mjs:183  refactor  too_big 99%, +3 more              P1 (1.4)
1f235668  docPage            …pts/build.mjs:82  docs      docs 81%, too_big 77%, +1 more    P1 (1.3)
eb9dfee4  versionAssets      …ts/build.mjs:161  security  resource_exhaustion 80%, +2 more  P1 (1.3)
1-3 of 27 open issues. --page 2 for the next
```

The first column is the id. Give it to `perch issues` to open one up:

```sh
perch issues 3a7c6bfe
```

That prints everything perch answered about the method. The severity
distribution, every vulnerability class with its probability, the line the defect
points at and how sure that pick was. It also lists the callers and callees that
were in view.

## Changing something and asking again

`perch check` puts the same questions to code as it reads on disk, uncommitted.
Nothing is recorded, so it is the one to run while you are working:

```sh
perch check 3a7c6bfe                          # whatever raised that issue
perch check scripts/build.mjs::build          # a method, by name
perch check scripts/build.mjs                 # a whole file
```

It exits 3 while something is still wrong, which is what a loop needs.


- [perch in CI](/ci/) for the pull request setup.
