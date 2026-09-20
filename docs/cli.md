---
title: Command reference
nav: Command reference
group: Reference
order: 8
summary: Every verb, every flag, and which ones need a key.
---

# Command reference

```
perch <command> [options]
```

| Verb | What it does | Needs |
| --- | --- | --- |
| [`scan`](#perch-scan) | Reads the repository at `HEAD` and writes down what it found. | `PERCH_API_KEY` |
| [`issues`](#perch-issues) | The open issues, worst first. With an id, everything known about that one method. | nothing |
| [`check`](#perch-check) | Asks about one file or method as it reads on disk. Records nothing. | `PERCH_API_KEY` |
| [`rules`](#perch-rules) | `list`, `add`, `edit`, `remove`: changes `perch.yaml` without opening it. | nothing |
| [`close`](#perch-close) | Sets issues aside so they stop being listed. | nothing |
| [`reopen`](#perch-reopen) | Undoes `close`. | nothing |
| [`doctor`](#perch-doctor) | What the last run did, and what it could not read. | nothing |

`perch findings` is the same command as `perch issues`.

Every command takes `--json`. That prints the same information for a script to
read. Every command that reads results takes
`--out DIR`, which is `.perch` by default.

## perch scan

Scores every method with tree-sitter, then reads them with System One, callers
and callees in view. Custom rules in `perch.yaml` and `.perch/rules/` are asked
in the same reading.

```sh
perch scan [target] [options]
```

`target` is the file or directory to read, and defaults to where you are.
`perch scan docs/` reads `docs/`.

`--paths` and `--since` narrow it further. Exits 3 on a defect, a vulnerability,
or a custom rule that broke.

| Flag | |
| --- | --- |
| `--paths a,b` | Only consider files under these repository paths. |
| `--since REF` | Only what changed since this branch or commit. `--since origin/main` is what CI wants. |
| `--parallel N` | How many methods to read at once. Default 8; files and tests go 32 at a time. |
| `--max-unit-requests N` | Request attempts per method or file check, including retries and line lookups. Default 64. Exhaustion reports incomplete and exits 1. |
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
| `--filter k=v` | Only issues matching, for example `type=security`, `kind=too_big`, `severity=P1`, `rule=no-silent-failure`. Comma-separated values are alternatives. |
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

Reads that one file off disk and asks about the point you named. That is every
rule covering it, plus the scan's own questions for a method. Nothing is
committed or recorded, so run it on work in progress. Exits 3 while something is
still wrong.

| Flag | |
| --- | --- |
| `--rules a,b` | Ask only these: rule names, or `defect`, `security`, `refactor`, `docs`. |
| `--max-unit-requests N` | Request attempts for this check, including retries and line lookups. Default 64. Exhaustion reports incomplete and exits 1. |
| `--out DIR` | Results directory. Default `.perch`. |
| `--json` | Print JSON instead of a summary. |
| `--verbose` | Show every file, method, model call, and command. |

## perch rules

```sh
perch rules [list | add <name> | edit <name> | remove <name>] [options]
```

Writes `perch.yaml`, keeping comments and ordering.

Most rules are a yes-or-no, so `--ensure` is usually the only flag you need. `--where` defaults
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

The fields are described in [Semantic linting](/rules/).

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

## perch setup

```sh
perch setup <claude-code | codex | pi | cursor> [options]
```

Installs instructions for using Perch in your coding assistant. Run this command
from your repository:

```console
$ perch setup claude-code
Wrote .claude/skills/perch/SKILL.md for Claude Code.
```

| Assistant | File |
| --- | --- |
| `claude-code` | `.claude/skills/perch/SKILL.md` |
| `codex` | `.codex/skills/perch/SKILL.md` |
| `pi` | `.pi/skills/perch/SKILL.md` |
| `cursor` | `.cursor/rules/perch.mdc` |

If the installed file already matches the bundled version, no changes are made.
To replace a modified or older file, use `--force`.

| Flag | Description |
| --- | --- |
| `--force` | Replace an existing file, including any local edits. |

Commit the generated file to share these instructions with your team.
See [Using Perch with coding assistants](skill.md).

## perch doctor

```
perch doctor
```

Checks the local environment and reports errors from the most recent scan.

```console
$ perch doctor
perch DEVELOPMENT (9478295)  node v25.5.0  darwin arm64

✓ node        v25.5.0
✗ key         PERCH_API_KEY is not set
✓ git         git version 2.50.1 (Apple Git-155)
✗ repository  /private/tmp/perch-doctor-d3mhms7w is not in a git repository
✓ results     /private/tmp/perch-doctor-d3mhms7w/.perch
✓ rules       no perch.yaml, so perch asks only its own questions

  key: export it, or put it in a .env beside the repository
  repository: perch reads a commit, so it needs one; git init and commit something

No run yet. perch scan is what reads the code.
```

Returns exit code `1` if an environment check fails.

The report also lists methods that could not be analyzed. For failed scans,
it includes the end of `.perch/scan.log`.

## Environment

| Variable | Read by |
| --- | --- |
| `PERCH_API_KEY` | `scan`, `check`: bearer token for the configured endpoint; required. |
| `PERCH_BASE_URL` | `scan`, `check`: exact request URL; defaults to `https://api.typesafe.ai/v1/systemone`. |
| `PERCH_MODEL_ID` | `scan`, `check`: model ID; defaults to `jev-latest`. |
| `NO_COLOR` | Everything that prints. Piped output is uncolored anyway. |

Set these variables to use a proxy, gateway, or local stand-in. `PERCH_BASE_URL`
is the complete URL to POST to, including its path and any query string.
perch uses it unchanged, including a trailing slash when supplied.

Set `PERCH_API_KEY` to the endpoint's bearer token and `PERCH_MODEL_ID` to the
model to request.

Changing the endpoint or model causes the next scan to ask again, including
file and search rules whose source has not changed.

The endpoint must support the System One request and response format: typed
questions over a state, answered with probabilities. An OpenAI-compatible chat
endpoint alone does not provide that contract.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command completed successfully. |
| `1` | Command failed. See the error message for details. |
| `2` | Invalid arguments, or `perch setup` requires `--force` to replace an existing file. |
| `3` | `scan` or `check` found issues. |

By default, scans check for defects, security vulnerabilities, and custom rule
violations. Use `scan_types` in `perch.yaml` to choose which issue types to check.

A scan exits with code `3` when it finds an issue. Set `gate: false` on a question
to record its results without changing the scan's exit code.
