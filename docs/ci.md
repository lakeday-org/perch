---
title: perch in CI
nav: perch in CI
group: Using perch
order: 6
summary: Scan every pull request with GitHub Actions or GitLab CI.
---

# perch in CI

## GitHub Actions

Add your API key as the repository secret `PERCH_API_KEY`, then commit this as `.github/workflows/perch.yml`:

```yaml
name: perch
on: pull_request

jobs:
  perch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/cache@v4
        with:
          path: .perch/scan.jsonl
          key: perch-${{ github.head_ref }}-${{ github.run_id }}
          restore-keys: perch-${{ github.head_ref }}-
      - run: npx --yes @lakeday/perch scan --since origin/${{ github.base_ref }}
        env:
          PERCH_API_KEY: ${{ secrets.PERCH_API_KEY }}
```

A pull request that adds a bug fails the job:

```console
$ npx --yes @lakeday/perch scan --since origin/main
cart.js
  ID        Line  Severity  Type    Confidence  Problem           Method
  450b87b4    18  P1 (1.4)  defect         76%  bad_state_change  removeItem

✖ 1 problem in 1 file, all failing
shop at commit a97a4f6: 4 methods, read 4
4 requests  13k tokens in / 2k out  $0.0005
```

`fetch-depth: 0` gives `--since` the base branch to compare against. The cache carries answers between pushes to the
same pull request, so a method that has not changed is not read again.

Pull requests from forks get no secrets. To skip them, add this to the job:

```yaml
    if: github.event.pull_request.head.repo.full_name == github.repository
```

## GitLab CI

Add `PERCH_API_KEY` as a masked CI/CD variable, then add this job to `.gitlab-ci.yml`:

```yaml
perch:
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: 0
  cache:
    key: perch-$CI_MERGE_REQUEST_IID
    paths: [.perch/scan.jsonl]
  script:
    - git fetch origin $CI_MERGE_REQUEST_TARGET_BRANCH_NAME
    - npx --yes @lakeday/perch scan --since origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME
```

## Exit codes

| Code | |
| --- | --- |
| 0 | nothing to act on |
| 1 | perch could not run |
| 2 | the command was typed wrong |
| 3 | perch found something that fails |

`scan_types` in `perch.yaml` sets which issue types fail the job. `perch rules edit <name> --gate false` reports a rule
without failing on it.
