# perch

`perch` finds real bugs in a repository, proves each one with a failing
regression test, and optionally fixes it. It runs entirely on your machine:
a tree-sitter pass ranks the riskiest source files, an OpenAI model
investigates each candidate, and every claim is checked by actually running
the regression test against a detached git worktree of the scanned revision.
Nothing is written to your working tree.

## Install

```
npm install
npm run build
npx perch --help
```

Requires Node 22+, `git`, `bash`, and an `OPENAI_API_KEY` (`OPENAI_BASE_URL` overrides the API endpoint). The `--issues` flag
also needs the GitHub CLI (`gh`) logged in.

## Usage

```
perch scan <target> [--fix] [--issues] [--paths a,b] [--candidates N] [--model M] [--out DIR] [--keep-workspace] [--json] [--verbose]
perch report [<target>]
```

`<target>` is a local directory (default `.`, resolved to its git root) or a
GitHub repository as `owner/repo` or `https://github.com/owner/repo`, which is
cloned into `<out>/repos/<owner>/<repo>` and fetched on later runs.

| Flag | Meaning |
| --- | --- |
| `--fix` | After proving a bug, ask the model for a fix, gate it on AST quality, rerun the regression and the project's baseline tests, get an independent review, and save a patch. |
| `--issues` | File one GitHub issue per proven bug with `gh issue create`, skipping titles that already have an open issue. |
| `--paths a,b` | Only consider files under these repository-relative paths. |
| `--candidates N` | Investigate the N riskiest files (default 4). |
| `--model M` | OpenAI model id; also `PERCH_MODEL`, default `gpt-5.6-luna`. |
| `--out DIR` | Results directory, default `<repo root>/.perch` (`./.perch` for GitHub targets). |
| `--keep-workspace` | Leave the scan worktree in place for inspection. |
| `--json` | Print the scan record instead of the summary. |
| `--verbose` | Print every script before it runs. |

## What a scan does

1. Lists tracked files at `HEAD`, keeps supported source files (JavaScript,
   TypeScript, Rust, Python, Go; no vendored, built, or test files), and
   analyzes each with tree-sitter to rank candidates by risk score.
2. Checks the revision out into a detached worktree under
   `<out>/workspaces/<scan-id>` and asks the model for `setup` and `baseline`
   scripts based on an inventory of local tools, manifests, and nearby tests.
   Both run locally with `bash -c`; the baseline must pass before any
   investigation starts.
3. For each candidate, the model returns either `found: false` or a regression
   test plus the command that runs it. The test is written into the workspace
   and run: it must fail with an assertion and leave tracked files untouched.
   Only then is an issue recorded.
4. With `--fix`, the model proposes a complete corrected file. It is accepted
   only if it parses and does not raise cyclomatic complexity, nesting, or risk
   score (three attempts). The regression must then pass, the baseline must
   still pass, nothing else may change, and an independent review must
   approve. The patch is saved under `<out>/scans/<scan-id>/patches/` and the
   `git apply` command is printed. Perch never opens pull requests.

Every model call and every script run is journaled in
`<out>/scans/<scan-id>/journal.json`. Re-running the same scan (same revision,
paths, candidate count, fix flag, and model) replays the journal and makes no
new model calls and runs no commands. Results live in `scan.json`,
`issues.json`, and `fixes.json` next to the journal; `perch report` prints the
latest ones.

Scripts written by the model run as your user. They are instructed not to
install system packages or write outside the workspace, but read them with
`--verbose` if the repository is unfamiliar.

## Development

```
npm test          # vitest: CLI units plus the analyzer package
npm run typecheck # tsc over analysis/
npm run build     # bundle src/cli.js into dist/cli.mjs
```
