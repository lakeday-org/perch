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
| [`scan`](#perch-scan) | Reads the repository at `HEAD` and writes down what it found. | `PERCH_BASE_URL` and `PERCH_API_KEY` |
| [`issues`](#perch-issues) | The open issues, worst first. With an id, everything known about that one method. | nothing |
| [`check`](#perch-check) | Asks about one file or method as it reads on disk. Records nothing. | `PERCH_BASE_URL` and `PERCH_API_KEY` |
| [`ci`](#perch-ci) | The CI runs Perch Cloud has of the branch. With an id, the issues one run found. | `perch login`, or a CI token in `PERCH_API_KEY` |
| [`cloud`](#perch-cloud) | Your Perch Cloud workspace, and how it scans this repository. `set` changes that. | `perch login` |
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
| `--parallel N` | How many methods to read at once. Default 32; files and tests go 32 at a time, alongside the methods. |
| `--force` | Ask Perch Cloud again instead of using cached answers, and keep the new answers. |
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
| `--force` | Ask Perch Cloud again instead of using cached answers. |
| `--out DIR` | Results directory. Default `.perch`. |
| `--json` | Print JSON instead of a summary. |
| `--verbose` | Show every file, method, model call, and command. |

## perch rules

```sh
perch rules [list | add <name> | edit <name> | remove <name>] [options]
```

Writes `perch.yaml`, or the split file under `.perch/rules/` that `--file` names, keeping comments and ordering.
`edit` and `remove` find the file a rule is in.

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
| `--file F` | The rule file: `perch.yaml` or a `.yaml` under `.perch/rules/`. `add` creates it. `list` shows only it. |
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
Added Perch Cloud's MCP server to .mcp.json. Claude Code signs in to it through Perch Cloud, in your browser.
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

It also adds Perch Cloud's MCP server, `perch-cloud` at
`https://dash.perchscan.com/mcp`, to `.mcp.json` for Claude Code and
`.cursor/mcp.json` for Cursor, and prints
`codex mcp add perch-cloud --url https://dash.perchscan.com/mcp` for Codex. An
existing `perch-cloud` entry is left as it is.

Commit the generated files to share these instructions with your team.
See [Using Perch with coding assistants](skill.md).

## perch ci

```sh
perch ci [run-id] [options]
```

The CI runs Perch Cloud has of the checked-out branch, newest first, with any
still going:

```console
$ perch ci
ID                                    Commit   Pull request  Result               When
043812ac-ea68-4c3b-88f0-737328f62826  5d7b033  #320          clean                23h ago
edf9f510-875c-44c8-8ff1-773e286be26e  a246d74  #320          clean                24h ago
6323adfc-9440-4640-badf-58c8e61cd5ba  d738e69  #320          4 problems, failing  45h ago
```

Give it a run ID for the issues that run found, laid out the way `perch scan`
prints them:

```console
$ perch ci 6323adfc-9440-4640-badf-58c8e61cd5ba
docs/coverage.md
  ID        Line  Severity  Type  Confidence  Problem                   Method
  8fd1e766     1  -         lint         72%  docs-sentences-are-short  docs/coverage.md

src/coverage.js
  ID        Line  Severity  Type    Confidence  Problem             Method
  8d9306ba   428  P1        defect         71%  wrong_return_value  askCoverage.<anonymous>.build
  7a5c2d1b   463  P1        defect         68%  wrong_return_value  askCoverage.<anonymous>.build#2

test/test-detection.test.js
  ID        Line  Severity  Type  Confidence  Problem                     Method
  69903bef     1  -         lint         61%  tests-assert-real-behavior  test/test-detection.test.…

✖ 4 problems in 3 files, failing
#320 at d738e69, finished 45h ago: https://dash.perchscan.com/#/scan/6323adfc-9440-4640-badf-58c8e61cd5ba
```

With `--json`, each issue's `method` is a target `perch check` takes.

On a pull request, each issue also says what became of Perch's review comment on
it: `open`, `resolved`, or `resolved by Perch` once a later scan stopped reporting
it, with the replies on the lines under it.

It reads Perch Cloud with your `perch login`, and the repository is the one the
`origin` remote names. A CI token in `PERCH_API_KEY` reads its own repository's
finished runs instead.

| Flag | |
| --- | --- |
| `--wait` | Wait for the run of the commit you are on to finish, or the run named, then print its issues. It gives up when no run of the commit has started within 10 minutes. |
| `--json` | Print JSON instead of a summary. |

Given a run, it exits as the run did: `3` when it found something that fails and
`1` when it could not finish.

## perch cloud

```sh
perch cloud [set] [options]
```

Who you are signed in as, the workspace, and how Perch Cloud scans this
repository's pull requests: whether it does, what a scan asks about, whether it
reads the changed code or the whole repository, and whether issues fail the Perch
Scan check. The repository is the one the `origin` remote names.

`perch cloud set` changes those settings and leaves what you do not name as it is.
It needs a workspace admin, and a `perch login`: a CI token reads CI runs and
nothing else.

| Flag | |
| --- | --- |
| `--pull_requests yes\|no` | Whether Perch Cloud scans this repository's pull requests. |
| `--scan_types a,b` | What a pull request scan asks about: `defect`, `security`, `lint`, `refactor`, `docs`. |
| `--scope changes\|all` | Whether a pull request scan reads the changed code or the whole repository. |
| `--gate yes\|no` | Whether issues fail the Perch Scan check on a pull request. |
| `--json` | Print JSON instead of a summary. |

## perch doctor

```
perch doctor
```

Checks the local environment and reports errors from the most recent scan.

Returns exit code `1` if an environment check fails.

The report also lists methods that could not be analyzed. For failed scans,
it includes the end of `.perch/scan.log`.

## Environment

| Variable | Read by |
| --- | --- |
| `PERCH_API_KEY` | `scan`, `check`: bearer token for the System One endpoint. |
| `PERCH_BASE_URL` | `scan`, `check`: complete System One request URL, or OpenAI's Decisions API URL. |
| `PERCH_MODEL_ID` | `scan`, `check`: model ID; defaults to `jev-latest`, or `gpt-6-luna` on the Decisions API. Set it to the endpoint's model, such as `d1:free` on Liquid AI. |
| `OPENAI_API_KEY` | `scan`, `check`: the Decisions API key, when `PERCH_API_KEY` is not set. |
| `PERCH_MAX_QUESTIONS` | `scan`, `check`: most questions in one request to `PERCH_BASE_URL`, for a model that does not report it. |
| `PERCH_MAX_OPTIONS` | `scan`, `check`: most options in one choice question, likewise. |

`PERCH_BASE_URL` is the complete URL to POST to, including its path and any
query string. perch uses it unchanged, including a trailing slash. To use
TypeSafe System One:

```sh
export PERCH_BASE_URL=https://api.typesafe.ai/v1/systemone
export PERCH_API_KEY='paste-your-TypeSafe-key-here'
```

To use a [Liquid AI decision model](https://docs.liquid.ai/lfm/models/decision-models),
which speaks the same format:

```sh
export PERCH_BASE_URL=https://api.liquid.ai/decisions/v1/systemone
export PERCH_API_KEY='paste-your-Liquid-key-here'
export PERCH_MODEL_ID=d1:free
```

To use OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions):

```sh
export PERCH_BASE_URL=https://api.openai.com/v1/decisions
export OPENAI_API_KEY='paste-your-OpenAI-key-here'
```

perch recognizes a URL whose path ends in `/decisions` and translates its
questions and answers to and from that API's format. The model defaults to
`gpt-6-luna`.

Any other endpoint must support the System One request and response format:
typed questions over a state, answered with probabilities. An OpenAI-compatible
chat endpoint alone does not provide that contract.

Models take different numbers of questions in one request. A model that reports
`max_questions` in its answers gets requests of that size: the first request is
kept to eight questions, and the rest are split to fit once it answers. For a
model that reports nothing, set `PERCH_MAX_QUESTIONS`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command completed successfully. |
| `1` | Command failed, a scan could not read some methods or rules after retrying, or the CI run `perch ci` showed could not finish. See the error message for details. |
| `2` | Invalid arguments, or `perch setup` requires `--force` to replace an existing file. |
| `3` | `scan` or `check` found issues, or the CI run `perch ci` showed did. |

By default, scans check for defects, security vulnerabilities, and custom rule
violations. Use `scan_types` in `perch.yaml` to choose which issue types to check.

A scan exits with code `3` when it finds an issue. Set `gate: false` on a question
to record its results without changing the scan's exit code.
