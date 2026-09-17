---
title: perch in CI
nav: perch in CI
group: Using perch
order: 6
summary: What CI can gate on, what it cannot, and a GitHub Actions job for pull requests.
---

# perch in CI

`perch scan` exits 1 when a rule you wrote in `perch.yaml` is broken, and 0
otherwise.

That split is deliberate. A rule is a claim you made about your own code, so
failing a build on it is you holding yourself to it. A finding perch turned up on
its own is a probability, and exiting on one would make every run a coin toss.

So CI gates on your rules, and reports everything else.

## Only what the branch changed

`--since` narrows the scan to what moved:

```sh
perch scan --since origin/main
```

A pull request reads the methods it touched and their neighbourhood, not the
whole repository. That is what keeps the job to a sensible size and cost.

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
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
        run: perch scan --since origin/${{ github.base_ref }}

      - name: the worst of what it found
        if: always()
        run: perch issues --all --min 80
```

`fetch-depth: 0` matters. Without the base branch in the checkout, `--since` has
nothing to compare against.

## Reporting without gating

To collect findings without failing anything, read the JSON and decide yourself:

```sh
perch scan --since origin/main --json > perch.json || true
jq '[.[] | select(.issues[]? | .type == "security" and .probability > 0.9)]' perch.json
```

## Sharing what the team set aside

`perch close` writes to `.perch/closed.jsonl`, which is separate from the answers
precisely so it can be committed. Commit it and the team's dismissals travel with
the repository, so CI does not re-report what somebody already looked at.

Add the rest of `.perch` to `.gitignore`:

```
.perch/*
!.perch/closed.jsonl
```

## Cost

One HTTP request per method read. `--since` decides how many methods that is,
`--parallel` decides how fast they go, and neither changes the total. Output
tokens are not billed, so the width of the question set is not what you are
paying for.
