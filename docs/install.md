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
$ perch scan
src/assets/hero.js
  ID        Line  Severity  Type      Sure  Problem             Method
  0c0b4209    46  -         docs       80%  docs                render
  0c0b4209    46  -         refactor   65%  tangled_conditions  render
  af40565c    61  P2 (1.6)  security   67%  uninitialized_use   play

src/index.html
  ID        Line  Severity  Type  Sure  Problem             Method
  99d1b053     7  -         lint   61%  no-narrative-prose  src/index.html

✖ 41 problems in 27 places in 7 files
1 rule broken.

  Failed  Rule                Description
       1  no-narrative-prose  A headline and one line, not a paragraph explaining the product.
perch-cloud at commit 3ddf4d9: 38 methods, read 30, 10 unchanged
30 requests  171k tokens in / 24k out  $0.0072
```

A method whose code, whose neighbours and whose questions are all unchanged since
the last run is not read again, which is what `10 unchanged` counts.

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

That prints everything perch answered about the method: the whole severity
distribution, every vulnerability class with its probability, which line the
defect points at and how confident that pick was, and which callers and callees
were in view when it read.

## Changing something and asking again

`perch check` puts the same questions to code as it reads on disk, uncommitted.
Nothing is recorded, so it is the one to run while you are working:

```sh
perch check 3a7c6bfe                          # whatever raised that issue
perch check scripts/build.mjs::build          # a method, by name
perch check scripts/build.mjs                 # a whole file
```

It exits 1 while something is still wrong, which is what a loop needs.

## Next

- [Reading issues](/issues/) for filtering and closing.
- [Your own rules](/rules/) to put your own questions in the same reading.
- [perch in CI](/ci/) for the pull request setup.
