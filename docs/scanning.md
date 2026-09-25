---
title: Scanning your code
nav: Scanning your code
group: Using perch
order: 2.5
summary: Scan a repository, a directory, a file, or what a branch changed.
---

# Scanning your code

`perch scan` reads every method under the directory you run it in and prints what it found, file by file:

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

The last two lines count the methods read and what the requests cost. The scan exits 3 when it finds something that
fails and 0 when it finds nothing.

## A directory or a file

Name a path to scan part of the repository:

```console
$ perch scan files.js
files.js
  ID        Line  Severity  Type      Confidence  Problem                Method
  623cd4c5     4  P0 (0.3)  security         90%  missing_authorization  readUpload
  623cd4c5     4  P0 (0.3)  defect           71%  unhandled_null         readUpload

✖ 2 problems in 1 file, all failing
shop at commit 19ff8ea: 2 methods, read 2
2 requests  6k tokens in / 1k out  $0.0003
```

Only methods under the path are read and reported. Their callers and callees elsewhere in the repository are still
shown to the model.

`--paths` takes several at once:

```sh
perch scan --paths src,lib
```

## What a branch changed

`--since` reads only the methods that changed since a branch or commit:

```console
$ perch scan --since origin/main
files.js
  ID        Line  Severity  Type      Confidence  Problem                Method
  623cd4c5     4  P0 (0.3)  security         89%  missing_authorization  readUpload
  623cd4c5     4  P0 (0.3)  defect           70%  unhandled_null         readUpload

✖ 2 problems in 1 file, all failing
shop at commit 19ff8ea: 2 methods, read 2
2 requests  6k tokens in / 1k out  $0.0003
```

This is the scan to run on a pull request. [perch in CI](/ci/) has the jobs.

## One kind of problem

`--filter` reports one type, kind or severity:

```console
$ perch scan --filter type=security
files.js
  ID        Line  Severity  Type      Confidence  Problem                Method
  623cd4c5     4  P0 (0.3)  security         89%  missing_authorization  readUpload

✖ 1 problem in 1 file, all failing
shop at commit 19ff8ea: 6 methods, read 6
6 requests  13k tokens in / 2k out  $0.0006
```

`--min 80` hides anything perch is less than 80% sure of. `--json` prints every answer instead of the table.

## Files to skip

Paths under `ignore` in `perch.yaml` are never read:

```yaml
ignore:
  - vendor/**
  - "**/*.generated.ts"
```

Dependencies and build output are skipped without being listed.
