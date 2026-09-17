# perch

[![npm](https://img.shields.io/npm/v/@lakeday/perch)](https://www.npmjs.com/package/@lakeday/perch)
[![ci](https://github.com/lakeday-org/perch/actions/workflows/ci.yml/badge.svg)](https://github.com/lakeday-org/perch/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@lakeday/perch)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@lakeday/perch)](LICENSE)

perch finds bugs and design problems in a repo and fixes them.

`perch scan` parses every tracked file with tree-sitter and scores each method.
It then asks a TypeSafe System One model a fixed set of questions about each
one. Every answer is a probability, so nothing comes back as a verdict. Methods
are sorted worst first.

`perch fix` hands a method to an OpenAI-compatible model with its issues as
objectives. The rewrite is committed only if a second scan expects fewer
problems, your tests still pass, and your linter and type checker still pass.

## Getting started

```sh
# 1. install
npm install -g @lakeday/perch

# 2. the key that reads code
export TYPESAFE_API_KEY=...

# 3. scan (later runs only re-read methods that changed)
perch scan

# 4. see what it found
perch issues

# 5. the key that writes code
export OPENAI_API_KEY=...

# 6. fix one, by the id in the first column
git checkout -b perch/sweep
perch fix 92c7781e
```

Needs Node 22+ and git. `perch fix` commits to the branch you're on and refuses
main and master.

## Commands

```
perch scan   [<target>] [--paths a,b] [--parallel N] [--force] [--all]
perch issues [<issue-id>] [--filter k=v] [--types] [--min P] [--limit N] [--page N] [--all] [--closed]
perch close  <issue-id>... [--reason R]
perch reopen <issue-id>...
perch doctor
perch fix    [<issue-id> | <path>] [--filter k=v] [--budget N] [--min P] [--effort E]
```

They all take `--out DIR` and `--json`.

| Verb | What it does | Needs |
| --- | --- | --- |
| `scan` | Parses every tracked file at HEAD, then reads methods with System One, walking the call graph from the worst-scoring method through its callers and callees. First scan reads everything; later scans only re-read what changed. Prints the table. | `TYPESAFE_API_KEY` |
| `issues` | The open issues, worst first. With an id, everything known about that one method. | nothing |
| `close` | Marks issues closed: false positives, or code you've looked at and aren't changing. They stop being listed and `perch fix` skips them. | nothing |
| `reopen` | Undoes `close`. | nothing |
| `doctor` | What the last run did and what it couldn't read. Names, paths and error messages only — no source, no answers — so it's safe to paste into a bug report. | nothing |
| `fix` | Fixes open issues, worst first, up to `--budget`. With a path, only that file or directory. With an id, just that one. One commit per fix. | both keys |

`perch findings` also works, same command.

### The table

```
ID        Method       Location        Type      Kind                            Severity  Status  Commit
92c7781e  fixMethod    src/fix.js:224  refactor  too_big 98%, unsafe_deser 87%   P1 (0.9)  open    -
```

- **Type** — `defect`, `security`, `refactor`, `docs` or `misaligned`.
  Whichever the row leads with.
- **Kind** — the specific problem and how sure the model is, worst first.
- **Severity** — the band, plus where the score landed inside it. `P1 (0.9)` is
  nearly P0, `P1 (1.2)` is closer to P2. Only shown when there's a bug.

Only issues the model is more than 50% sure about get listed. `--min` changes
that: `--min 80` for the obvious ones, `--min 0` for everything it answered.

`--filter` narrows on the Type, Kind and Severity columns. `--types` prints the
valid values.

Not every finding is worth acting on. `perch close` takes them off the list:

```sh
perch close e585492e --reason "verifies the HMAC before parsing"
perch close 3b7c9da1 2cce8403 --reason "pre-existing, well tested, not restructuring"
```

A dismissal is about the method as it reads now, so editing that method brings
the issue back. `--closed` lists them, `perch issues <id>` shows the reason.

```sh
perch issues --filter type=security
perch issues --filter kind=too_big --min 80
perch fix --filter severity=P1 --budget 5
```

Filtered lists print every match and put the thing you filtered for first in
each row. Unfiltered lists are cut to 10 unless you pass `--all`.

To walk a long list, `--limit` sets the page size and `--page` picks one. A line
under the table says where you are:

```sh
perch issues --limit 25            # 1-25 of 235 open issues. --page 2 for the next
perch issues --limit 25 --page 4   # 76-100 of 235 open issues. --page 5 for the next
```

### Flags

| Flag | Meaning |
| --- | --- |
| `--paths a,b` | Only look at these paths. |
| `--parallel N` | Methods read at once (default 8). |
| `--force` | Re-read every method, even unchanged ones. |
| `--filter k=v` | e.g. `type=security,severity=P1`. |
| `--types` | Print what `--filter` accepts and exit. |
| `--min P` | Only issues the model is at least P% sure of (default 50). |
| `--reason R` | Why you closed something. Kept on the record. |
| `--budget N` | Fix at most N issues (default 20). |
| `--effort E` | `none`, `low`, `medium`, `high`, `xhigh`, `max` (default `medium`). |
| `--limit N` | Rows per page (default 10). |
| `--page N` | Which page of them, 1 is the first. |
| `--all` | Print every row instead of the top 10. |
| `--closed` | Include closed issues. |
| `--out DIR` | Results directory (default `.perch`). |
| `--json` | Print the record instead of the table. |
| `--verbose` | Show every file, method, model call and command. |

### Environment

| | |
| --- | --- |
| `TYPESAFE_API_KEY` | `scan`, and the rescan `fix` is judged by. |
| `OPENAI_API_KEY` | `fix`. |
| `OPENAI_MODEL` | Which model writes the fix. `--model` overrides it. |
| `OPENAI_BASE_URL` | Any endpoint that speaks the OpenAI Responses API. |

`<target>` is a directory (default `.`, resolved to its git root) or a GitHub
repo as `owner/repo` or a URL, which gets cloned under `<out>/repos/`.
`<issue-id>` is the 8-char id in the first column; a unique prefix works.

### When a scan goes wrong

A method perch can't read — a request too large for the model, a service that
times out — is recorded against that method and the walk carries on. `perch
doctor` says what happened:

```
perch 0.1.0 on node v22.14.0 (linux x64)
results in .perch

hunt 462cfe79 complete at 2026-09-17T00:36:33
  49213 methods, read 48967, 0 unchanged, 0 unread, 246 failed
  243 methods could not be read:
    241x System One request failed with HTTP 400: max_tokens_exceeded
        build_response at src/handlers/api.py:1204
        ...
```

If nothing can be read — a bad key, a service that's down — the run stops
instead of spending the rest of the repository finding out.

## How it works

- [doc/scan.md](doc/scan.md) — the graph walk, the questions, and how
  probabilities turn into a ranking.
- [doc/fix.md](doc/fix.md) — the agent, its verifiers, and what a rewrite has to
  beat to get committed.

Results go in `<out>`: an append-only `events.jsonl` with one line per method
read and per fix made, plus scan, hunt and fix records. Nothing else is written
to your tree except the commits `fix` makes.

## Development

```sh
npm run check     # lint, typecheck, test
npm run build     # bundle src/cli.js into dist/cli.mjs
```

From a checkout: `npm install && npm run build && npm link` puts `perch` on your
path.
