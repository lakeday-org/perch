---
title: perch in CI
nav: perch in CI
group: Using perch
order: 6
summary: What CI can gate on, what it cannot, and a GitHub Actions job for pull requests.
---

# perch in CI

`perch scan` exits 3 when it found something wrong, and 0 otherwise.

| | |
| --- | --- |
| 0 | nothing to act on |
| 1 | perch could not run: no key, no git, a request that kept failing |
| 2 | the command was typed wrong |
| 3 | perch ran and found something that fails |

CI shows those as different results. A run that could not start never reads as
a run that found a bug.

Everything a scan asks about fails it. `scan_types` in `perch.yaml` decides what
it asks about, and defaults to defects, vulnerabilities and rules. A type not
worth stopping for is left out rather than reported and ignored.

`perch rules list` prints the setting in a Fails column. `perch rules edit
<name> --gate false` records a question's answer without acting on it.

## Branch scope

`--since` narrows the scan to what moved:

```console
$ perch scan --since origin/main
checkout.py
  ID        Line  Severity  Type    Confidence  Problem     Method
  bdc67421    14  P1 (0.8)  defect         81%  wrong_order  place_order

✖ 1 problem in 1 file, all failing
perch at commit 5e9d910: 3 methods, read 3
3 requests  10k tokens in / 2k out  $0.0004
```

A pull request reads the methods it touched and their neighbourhood. That is a
handful of requests where a whole repository is hundreds.

## GitHub Actions

```yaml
name: perch
on: pull_request

jobs:
  perch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # --since needs the base branch

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - run: npm install -g @lakeday/perch

      - name: scan what this branch changed
        env:
          PERCH_API_KEY: ${{ secrets.PERCH_API_KEY }}
        run: perch scan --since origin/${{ github.base_ref }}

      - name: the worst of what it found
        if: always()
        run: perch issues --all --min 80
```

Without the base branch in the checkout, `--since` has nothing to compare
against, so `fetch-depth: 0` is not optional.

## Reports without gating

To collect findings without failing anything, read the JSON and decide yourself:

```sh
perch scan --since origin/main --json > perch.json || true
jq '[.[] | select(.issues[]? | .type == "security" and .probability > 0.9)]' perch.json
```

## Shared closures

`perch close` writes to `.perch/closed.jsonl`, which is kept separate from the
answers so it can be committed. Commit it and the team's dismissals travel with
the repository, so CI does not re-report what somebody already looked at.

Add the rest of `.perch` to `.gitignore`:

```
.perch/*
!.perch/closed.jsonl
```

## Cost

One HTTP request per method read. `--since` decides how many methods that is,
`--parallel` decides how fast they go, and neither changes the total. Output
tokens are not billed, so asking thirty questions of a method costs what asking
one costs.
