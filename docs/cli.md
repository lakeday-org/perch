---
title: Command reference
nav: Command reference
group: Reference
order: 7
summary: Every verb, every flag, and which ones need a key.
---

# Command reference

```
perch <command> [options]
```

| Verb | What it does | Needs |
| --- | --- | --- |
| [`scan`](#perch-scan) | Reads the repository at `HEAD` and writes down what it found. | `TYPESAFE_API_KEY` |
| [`issues`](#perch-issues) | The open issues, worst first. With an id, everything known about that one method. | nothing |
| [`check`](#perch-check) | Asks about one file or method as it reads on disk. Records nothing. | `TYPESAFE_API_KEY` |
| [`rules`](#perch-rules) | `list`, `add`, `edit`, `remove`: changes `perch.yaml` without opening it. | nothing |
| [`close`](#perch-close) | Sets issues aside so they stop being listed. | nothing |
| [`reopen`](#perch-reopen) | Undoes `close`. | nothing |
| [`doctor`](#perch-doctor) | What the last run did, and what it could not read. | nothing |

`perch findings` is the same command as `perch issues`.

Every command takes `--json`, which prints the same information for a script to
read instead of a summary for a person. Every command that reads results takes
`--out DIR`, which is `.perch` by default.

## perch scan

Scores every method with tree-sitter, then reads them with System One, callers
and callees in view. Your rules in `perch.yaml` are asked in the same reading.

```sh
perch scan [target] [options]
```

`target` is a directory, `owner/repo`, or a GitHub URL. It defaults to the
current repository.

Every run reads everything it covers. `--paths` and `--since` narrow what that
is. Exits 1 if a rule is broken.

| Flag | |
| --- | --- |
| `--paths a,b` | Only consider files under these repository paths. |
| `--since REF` | Only what changed since this branch or commit. `--since origin/main` is what CI wants. |
| `--parallel N` | How many methods to read at once. Default 8; files and tests go 32 at a time. |
| `--all` | List every row instead of the top 10. |
| `--min P` | Only issues perch is at least P percent sure of. Default 50; `--min 0` shows everything it answered. |
| `--out DIR` | Results directory. Default `.perch`. |
| `--json` | Print JSON instead of a summary. |
| `--verbose` | Show every file, method, model call, and command. |

## perch issues

```sh
perch issues [issue-id] [options]
```

Worst first, ten rows at a time. Give it an id to see everything known about that
method.

| Flag | |
| --- | --- |
| `--filter k=v` | Only issues matching, for example `type=security`, `kind=too_big`, `severity=P1`. Comma-separated values are alternatives. |
| `--types` | Print everything `--filter` accepts, and stop. |
| `--all` | List every row instead of the top 10. |
| `--limit N` | Rows per page. Default 10. |
| `--page N` | Which page, 1 is the first. |
| `--closed` | Include closed issues. |
| `--min P` | Only issues perch is at least P percent sure of. Default 50. |
| `--out DIR` | Results directory. Default `.perch`. |
| `--json` | Print JSON instead of a summary. |

## perch check

```sh
perch check <path | path::method | issue-id> [options]
```

Reads that one file off disk and asks about the point you named: every rule that
covers it, plus the scan's own questions for a method. Nothing is committed or
recorded, so run it on work in progress. Exits 1 if something is wrong.

| Flag | |
| --- | --- |
| `--rules a,b` | Ask only these: rule names, or `defect`, `security`, `refactor`, `docs`. |
| `--out DIR` | Results directory. Default `.perch`. |
| `--json` | Print JSON instead of a summary. |
| `--verbose` | Show every file, method, model call, and command. |

## perch rules

```sh
perch rules [list | add <name> | edit <name> | remove <name>] [options]
```

Writes `perch.yaml`, keeping your comments and ordering.

Most rules are a yes-or-no, and `--ensure` is all one needs. `--where` defaults
to `**/*` and the unit defaults to the file as a whole:

```sh
perch rules add no-narrative-prose --ensure "A headline and one line, not a paragraph explaining the product."
```

| Flag | |
| --- | --- |
| `--ensure TEXT` | What has to be true of every file or method it covers. |
| `--ensure_present TEXT` | Something that has to be somewhere in what it covers. |
| `--ensure_absent TEXT` | Something that must not be anywhere in what it covers. |
| `--where W` | What it covers: a glob, `callers of <method>`, or `mentions <text>`. Default `**/*`. |
| `--except W` | A glob it spares. |
| `--each U` | Ask about each `file`, `method`, or `test` rather than the file as a whole. |
| `--sees S` | What a file or test is shown besides itself: `file`, `calls`, `callers`, or `neighbors`. |
| `--min P` | The floor for this rule alone, in percent. |
| `--json` | Print JSON instead of a summary. |

An answer that is not yes-or-no is written out:

| Flag | |
| --- | --- |
| `--type T` | The shape of the answer: `noul`, `choice`, `score`. Default `noul`. |
| `--ask TEXT` | The question itself, in place of `--ensure`. |
| `--true TEXT` / `--false TEXT` | What a yes and a no mean, for `--type noul`. |
| `--options "a=..; b=.."` | The options and what each means, for `--type choice`. |
| `--levels "a; b; c"` | The rubric, weakest first, for `--type score`. |
| `--when NAME` | Another question this one is only as likely as. The two multiply. |
| `--issue "type=..,label=.."` | What an answer means: `type`, `label`, `on`, `pick`, `except`. |

The fields are described in [Your own rules](/rules/).

## perch close

```sh
perch close <issue-id>... [options]
```

Stops an issue being listed: a false positive, or code you have looked at and are
not changing. `--reason` is kept and shown by `perch issues <id>`.

| Flag | |
| --- | --- |
| `--reason R` | Why you are setting these aside, kept on the record. |
| `--out DIR` | Results directory. Default `.perch`. |
| `--json` | Print JSON instead of a summary. |

## perch reopen

```sh
perch reopen <issue-id>... [options]
```

Puts closed issues back on the list.

## perch doctor

```sh
perch doctor [options]
```

Versions, what the last scan did, and every method it failed to read with the
error it failed on. Names, paths and errors only, no source and no answers, so it
is safe to paste into a bug report.

## Environment

| Variable | Read by |
| --- | --- |
| `TYPESAFE_API_KEY` | `scan`, `check` |
| `NO_COLOR` | Everything that prints. Piped output is uncolored anyway. |

## Exit codes

| Code | |
| --- | --- |
| `0` | Ran, and nothing you claimed about your code was broken. |
| `1` | `scan`: a rule in `perch.yaml` was broken. `check`: something it asked about is wrong. Any command: it could not run. |
