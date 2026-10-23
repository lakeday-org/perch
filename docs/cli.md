---
title: Command reference
nav: Command reference
group: Reference
order: 8
summary: Every command, its flags, the environment variables perch reads, and its exit codes.
---

# Command reference

The Perch command line interface (CLI) lets you scan code, review issues and manage rules from your terminal. Every
command follows the same pattern:

```
perch <command> [options]
```

| Command | Description | Needs |
| --- | --- | --- |
| [`login`](#perch-login) | Sign in to Perch Cloud. | a browser |
| [`logout`](#perch-logout) | Remove this device's Perch Cloud login. | nothing |
| [`scan`](#perch-scan) | Scan the repository at `HEAD` and save the issues. | [a model endpoint](#environment) |
| [`coverage`](#perch-coverage) | Run your tests against mutated code and list the gaps. | a model endpoint and your test tools |
| [`issues`](#perch-issues) | List the issues the last scan found, or show one. | nothing |
| [`check`](#perch-check) | Check one file or method on disk without recording anything. | a model endpoint |
| [`rules`](#perch-rules) | List, add, edit and remove rules in `perch.yaml`. | nothing |
| [`close`](#perch-close) | Close issues. | nothing |
| [`reopen`](#perch-reopen) | Reopen closed issues. | nothing |
| [`setup`](#perch-setup) | Install the Perch skill for a coding assistant. | nothing |
| [`ci`](#perch-ci) | List this branch's CI runs, or show one run's issues. | `perch login`, or a CI token in `PERCH_API_KEY` |
| [`cloud`](#perch-cloud) | Show or change this repository's Perch Cloud settings. | `perch login` |
| [`doctor`](#perch-doctor) | Check that Perch can run, and report on the last run. | nothing |

Commands that need a model endpoint use Perch Cloud by default. You can sign in with `perch login`, a CI token or a GitHub
Actions OIDC token, or set `PERCH_BASE_URL` to use a different endpoint. See [Environment](#environment).

Every command accepts `--json`, which prints the same information as JSON. Commands that read or write results accept
`--out DIR`, which defaults to `.perch`. To see a command's options, run `perch <command> --help`. `perch findings` is another
name for `perch issues`.

## perch login

```
perch login [organization-id]
```

Prints a link and a code to confirm in your browser, then saves the login to `~/.perch/cloud.json`, outside the
repository. If your account belongs to more than one organization, Perch lists them and asks you to run `perch login <id>`
with the one you want.

## perch logout

```
perch logout
```

Removes the login saved on this device. To revoke a CI token, use the Perch Cloud dashboard.

## perch scan

```
perch scan [target] [options]
```

Parses the repository at `HEAD` with tree-sitter, then asks the model about each method with its callers and callees in
view. Custom rules from `perch.yaml` and `.perch/rules/` are asked at the same time. `target` is a file or directory to scan,
and defaults to the current directory.

The scan exits with code 3 when it lists a problem. `scan_types` in `perch.yaml` sets which types of problem it asks
about, and defaults to `defect` and `lint`.

With `--since`, Perch asks the bug questions `has_bug`, `bug_edge_case`, `kind` and `severity` only about methods the diff
touches. That request contains the method's code at the merge base with `REF` and the diff, without callers or callees. Custom
rules are asked of every method in the changed files, with callers and callees.

| Flag | Description |
| --- | --- |
| `--paths a,b` | Scan only files under these repository paths. |
| `--since REF` | Scan only what changed since this branch or commit. Use `--since origin/main` in CI. |
| `--filter k=v` | Ask only the questions that can raise a matching issue, such as `type=security`, `kind=off_by_one` or `rule=<name>`. `severity=` asks everything. The scan fails only on what it lists. |
| `--include-tests` | Also review test code and test helpers. |
| `--include-files` | Also parse documents, configuration, styles and templates with their own grammars. |
| `--parallel N` | How many methods to ask about at once. Default 32. Files and tests run 32 at a time alongside them. |
| `--force` | Ask again instead of using Perch Cloud's cached answers, and replace the cached answers. |
| `--min P` | List only issues Perch is more than P percent sure of. Default 50. `--min 0` lists everything. |
| `--all` | List every row instead of the top 10. |
| `--out DIR` | Results directory. Default `.perch`. |
| `--json` | Print JSON instead of the table. |
| `--verbose` | Show every file, method, model call and command. |

## perch coverage

```
perch coverage [target] [options]
```

Runs your tests against small edits to your code, called mutants, and asks the model which surviving mutants a caller
could notice. It lists those survivors, tests that catch nothing, and tests that catch exactly what another test catches.
[Test coverage](/coverage/) explains the output and lists the supported test frameworks. It exits with code 3 when it lists a problem and 1 when it can't run your
tests.

| Flag | Description |
| --- | --- |
| `--paths a,b` | Cover only files under these repository paths. |
| `--since REF` | Report only problems in code changed since this branch or commit. |
| `--diff REF` | Compare with the run saved at this branch or commit. |
| `--filter kind=` | Only these kinds of problem: `survived`, `redundant`, `checks_nothing`, `mocked`, `infra`. |
| `--parallel N` | How many tests or methods to ask about at once. Default 32. |
| `--min P` | List only problems Perch is more than P percent sure of. Default 50. |
| `--all` | List every method and every surviving mutant instead of the top 10. |
| `--html FILE` | Where to write the HTML report. Default `coverage/index.html` under `--out`. |
| `--out DIR` | Results directory. Default `.perch`. |
| `--json` | Print JSON instead of the tables. |
| `--verbose` | Show every file, method, model call and command. |

## perch issues

```
perch issues [issue-id] [options]
```

Lists open issues from the last scan, most serious first, 10 rows at a time. With an issue ID, it shows everything Perch
recorded about that method. It reads `.perch` and sends no requests.

| Flag | Description |
| --- | --- |
| `--filter k=v` | Only issues that match, such as `type=security`, `kind=off_by_one`, `severity=P1` or `rule=<name>`. Separate several values with commas. |
| `--types` | Print every value `--filter` accepts, then exit. |
| `--all` | List every row instead of the top 10. |
| `--limit N` | Rows per page. Default 10. |
| `--page N` | Which page to show, starting at 1. |
| `--closed` | Include closed issues. |
| `--min P` | List only issues Perch is more than P percent sure of. Default 50. |
| `--out DIR` | Results directory. Default `.perch`. |
| `--json` | Print JSON instead of the table. |

## perch check

```
perch check <path | path::method | issue-id> [options]
```

Checks a single method or file as it is on disk. For a method, Perch asks its built-in questions and every custom rule
that applies to it. For a file, it asks the rules that apply to the file. `perch check` works on uncommitted code and
doesn't save its results. It exits with code 3 if anything it checked is still broken.

| Flag | Description |
| --- | --- |
| `--rules a,b` | Ask only these: rule names, or `defect`, `security`, `refactor`, `docs`. |
| `--force` | Ask again instead of using Perch Cloud's cached answers. |
| `--out DIR` | Results directory. Default `.perch`. |
| `--json` | Print JSON instead of the table. |
| `--verbose` | Show every file, method, model call and command. |

## perch rules

```
perch rules [list | add <name> | edit <name> | remove <name>] [options]
```

Writes rules to `perch.yaml`, or to the file under `.perch/rules/` that `--file` names, and keeps the file's comments and
order. `edit` and `remove` find the file a rule is in. Most rules are a yes-or-no sentence, so `--ensure` is often the only
flag you need:

```sh
perch rules add errors-reach-the-caller --each method --where "**/*.py" --ensure "When this method catches an exception, it raises it again or returns an error."
```

| Flag | Description |
| --- | --- |
| `--ensure TEXT` | A sentence that has to be true of every file or method the rule covers. |
| `--ensure_present TEXT` | Something that has to exist somewhere in what the rule covers. |
| `--ensure_absent TEXT` | Something that must not exist anywhere in what the rule covers. |
| `--where W` | What the rule covers: a glob, `callers of <method>`, or `mentions <text>`. Default `**/*`. |
| `--except W` | A glob for paths the rule skips. |
| `--each U` | Ask about each `file`, `method` or `test` instead of each file as a whole. |
| `--sees S` | What else to show with a file or test: `file`, `calls`, `callers` or `neighbors`. |
| `--min P` | The floor for this rule, in percent. |
| `--gate yes\|no` | Whether breaking the rule fails a scan. Default yes. |
| `--file F` | The rule file: `perch.yaml` or a `.yaml` file under `.perch/rules/`. `add` creates it, and `list` shows only it. |
| `--json` | Print JSON instead of the table. |

For a question whose answer isn't yes or no, use the longhand flags:

| Flag | Description |
| --- | --- |
| `--type T` | The kind of answer: `noul`, `choice` or `score`. Default `noul`. |
| `--ask TEXT` | The question, in place of `--ensure`. |
| `--true TEXT` / `--false TEXT` | What a yes and a no mean, for `--type noul`. |
| `--options "a=..; b=.."` | The options and what each one means, for `--type choice`. |
| `--levels "a; b; c"` | The grades, weakest first, for `--type score`. |
| `--when NAME` | Another question this one depends on. Perch multiplies the two probabilities. |
| `--issue "type=..,label=.."` | What an answer means: `type`, `label`, `on`, `pick`, `except`. |

[Semantic linting](/rules/) has an example of each kind of rule.

## perch close

```
perch close <issue-id>... [options]
```

Closes one or more issues, such as false positives or code you've reviewed and decided to keep. A closed issue stays
closed through later scans and edits until you reopen it, and `perch issues <id>` shows the reason you gave. You can also
close a problem reported by `perch coverage` by passing its ID.

| Flag | Description |
| --- | --- |
| `--reason R` | Why you're closing it. Perch keeps the reason with the issue. |
| `--kind a,b` | Close only these kinds of problem on the issue, such as `docs` or `too_big`. Default: every kind on it now. |
| `--out DIR` | Results directory. Default `.perch`. |
| `--json` | Print JSON instead of a summary. |

## perch reopen

```
perch reopen <issue-id>... [options]
```

Puts closed issues back on the list. `--kind` reopens only some kinds of problem on an issue.

## perch setup

```
perch setup <claude-code | codex | pi | cursor> [options]
```

Installs the Perch skill for a coding assistant in the current repository:

| Assistant | File |
| --- | --- |
| `claude-code` | `.claude/skills/perch/SKILL.md` |
| `codex` | `.codex/skills/perch/SKILL.md` |
| `pi` | `.pi/skills/perch/SKILL.md` |
| `cursor` | `.cursor/rules/perch.mdc` |

It also adds Perch Cloud's MCP server, `perch-cloud` at `https://dash.perchscan.com/mcp`, to `.mcp.json` for Claude Code
and `.cursor/mcp.json` for Cursor. For Codex, it prints the `codex mcp add` command to run. An existing `perch-cloud`
entry is left as it is.

If the skill file matches the one this version of Perch ships, Perch changes nothing. If it differs, because you edited it
or an older Perch wrote it, Perch leaves it alone and exits with code 2.

| Flag | Description |
| --- | --- |
| `--force` | Replace the skill file, including your edits. |
| `--json` | Print JSON instead of a summary. |

[perch in a coding assistant](/skill/) lists what the skill tells the assistant to do.

## perch ci

```
perch ci [run-id] [options]
```

Lists this branch's CI runs in Perch Cloud, newest first, including runs still in progress:

```console
$ perch ci
ID                                    Commit   Pull request  Result               When
043812ac-ea68-4c3b-88f0-737328f62826  5d7b033  #320          clean                23h ago
edf9f510-875c-44c8-8ff1-773e286be26e  a246d74  #320          clean                24h ago
6323adfc-9440-4640-badf-58c8e61cd5ba  d738e69  #320          4 problems, failing  45h ago
```

With a run ID, it shows that run's issues in the same layout as `perch scan`:

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

On a pull request, each issue also shows the state of Perch's review comment on it: `open`, `resolved`, or
`resolved by Perch` when a later scan stopped reporting it. Replies are listed underneath. With `--json`, each issue's
`method` works as a `perch check` target.

`perch ci` uses your `perch login` and the repository named by the `origin` remote. A CI token in `PERCH_API_KEY` also
works, but sees only its own repository's finished runs. With a run ID, it exits with the run's result: 3 if the run found
failing issues, and 1 if the run didn't finish.

| Flag | Description |
| --- | --- |
| `--wait` | Wait for the current commit's run, or the named run, to finish, then print its issues. Gives up if no run starts within 10 minutes. |
| `--json` | Print JSON instead of the table. |

## perch cloud

```
perch cloud [set] [options]
```

Shows your account, your workspace, and this repository's pull request settings in Perch Cloud: whether the GitHub app is
installed, whether pull requests are scanned, which types of problem are asked about, whether Perch reads the changed code
or the whole repository, and whether issues fail the Perch Scan check. The repository is the one the `origin` remote
names.

`perch cloud set` changes the settings you pass and leaves the rest. It needs a workspace admin signed in with
`perch login`. A CI token can't read or change settings.

| Flag | Description |
| --- | --- |
| `--pull_requests yes\|no` | Whether Perch Cloud scans this repository's pull requests. |
| `--scan_types a,b` | Types of problem to ask about: `defect`, `security`, `lint`, `refactor`, `docs`. |
| `--scope changes\|all` | Scan the changed code or the whole repository. |
| `--gate yes\|no` | Whether issues fail the Perch Scan check on a pull request. |
| `--json` | Print JSON instead of a summary. |

## perch doctor

```
perch doctor [options]
```

Checks that Perch can run here: Node, credentials, git, the repository and commit, the results directory, and whether
`perch.yaml` parses. A failed check says how to fix it, and the command exits with code 1.

Below that, it reports on the last run: every method it couldn't read and the error, every question it asked and what each
one raised, and the end of `.perch/scan.log` if the run didn't finish. The report contains names, paths, counts and error
messages but no source code, so you can paste it into a bug report.

## Environment

Perch sends scan, coverage and check requests to Perch Cloud unless `PERCH_BASE_URL` names another endpoint. Without
`PERCH_BASE_URL`, it signs in to Perch Cloud with the first of these it finds: a CI token in `PERCH_API_KEY`, the login
saved by `perch login`, or a GitHub Actions job's OIDC token when the job has `id-token: write`.

| Variable | Description |
| --- | --- |
| `PERCH_API_KEY` | A Perch Cloud CI token, or your key for `PERCH_BASE_URL`. |
| `PERCH_BASE_URL` | Another endpoint to send questions to, as the exact URL to POST to. A URL ending in `/decisions` is OpenAI's Decisions API. |
| `PERCH_MODEL_ID` | The model to ask. Defaults to the model Perch Cloud serves, `gpt-6-luna` on the Decisions API, or `jev-latest` on any other endpoint. |
| `OPENAI_API_KEY` | The Decisions API key, when `PERCH_API_KEY` is not set. |
| `TYPESAFE_API_KEY` | The key for any other `PERCH_BASE_URL`, when `PERCH_API_KEY` is not set. |
| `PERCH_MAX_QUESTIONS` | The most questions to send in one request, for a `PERCH_BASE_URL` model that doesn't report its limit. |
| `PERCH_MAX_OPTIONS` | The most options in one choice question, for the same kind of model. |
| `PERCH_ORGANIZATION` | The Perch Cloud organization to use, when your login belongs to several. |
| `PERCH_REPOSITORY` | The Perch Cloud repository ID, in place of the one the `origin` remote names. |

Perch uses `PERCH_BASE_URL` exactly as given, including its path, query string and any trailing slash. To use TypeSafe
System One:

```sh
export PERCH_BASE_URL=https://api.typesafe.ai/v1/systemone
export PERCH_API_KEY='paste-your-TypeSafe-key-here'
```

To use a [Liquid AI decision model](https://docs.liquid.ai/lfm/models/decision-models), which uses the same request format:

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

Perch translates its questions and answers to and from the Decisions API format when the URL's path ends in `/decisions`.

Any other endpoint must accept the System One format, where typed questions about a piece of code are answered with
probabilities. An OpenAI-compatible chat endpoint does not accept it.

Models accept different numbers of questions in one request. If a model reports `max_questions` in its answers, Perch keeps
its first request to eight questions and sizes later requests to fit. For a model that reports nothing, set
`PERCH_MAX_QUESTIONS`.

### Configuration file

`~/.perch/config.toml` sets defaults for this machine. It accepts four settings, each a quoted string:

```toml
organization = "your-organization-id"
repository = "your-repository-id"
base_url = "https://api.typesafe.ai/v1/systemone"
model = "jev-latest"
```

They set `PERCH_ORGANIZATION`, `PERCH_REPOSITORY`, `PERCH_BASE_URL` and `PERCH_MODEL_ID`. An environment variable
overrides the file.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command finished and found nothing that fails it. |
| `1` | The command failed. A scan that couldn't read some methods or rules after retrying exits with 1, and so does `perch ci` for a run that didn't finish, and `perch doctor` when a check fails. |
| `2` | The command line was wrong, or `perch setup` needs `--force` to replace a file you edited. |
| `3` | `scan`, `check`, `coverage`, or a CI run shown by `perch ci`, found something that fails it. |

A scan asks about defects and custom rules unless `scan_types` in `perch.yaml` lists other types, and any problem it lists
makes it exit with 3. A rule with `gate: false` is still listed, but doesn't change the exit code.
