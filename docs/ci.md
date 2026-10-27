---
title: perch in CI
nav: perch in CI
group: Using perch
order: 6
summary: Scan every pull request with Perch Cloud, GitHub Actions or GitLab CI.
---

# perch in CI

You can scan every pull request with Perch in one of three ways:

- Let Perch Cloud scan pull requests for you through its GitHub app. You don't need to change your CI configuration.
- Add a job to GitHub Actions, GitLab CI or another CI provider that runs `perch scan` and sends its results to Perch
  Cloud.
- Add a job that runs `perch scan` against your own model endpoint.

## Perch Cloud

When the Perch GitHub app is installed on a repository, Perch Cloud scans each pull request and reports the result as a
check named Perch Scan, with a review comment on each problem it finds.

To see a repository's settings, run `perch cloud` in the repository:

```console
$ perch cloud
Signed in as   you@example.com
Workspace      Example (owner)
Repository     lakeday-org/perch
GitHub app     installed
Pull requests  scanned
Asks about     defect, lint, security
Reads          the changed code
Issues         fail the Perch Scan check
```

If the app isn't installed, the `GitHub app` line shows where to install it. Workspace admins can change these settings
with `perch cloud set`. For example:

```sh
perch cloud set --scan_types defect,security,lint --scope changes --gate yes
```

To see what Perch Cloud found on your branch, use [`perch ci`](/cli/#perch-ci).

## GitHub Actions

To run Perch in GitHub Actions, add the following workflow to `.github/workflows/perch.yml`:

```yaml
name: perch
on: pull_request

permissions:
  contents: read
  id-token: write

jobs:
  perch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # --since needs the base branch's history.
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx --yes @lakeday/perch scan --since origin/${{ github.base_ref }}
```

The `id-token: write` permission lets Perch sign in to Perch Cloud with the job's OIDC token, so you don't need to store
an API key as a secret. The repository must be connected to Perch Cloud. Perch sends the results of each scan to Perch
Cloud, where you can view them with `perch ci`.

If a pull request introduces a bug, the job fails with output like this:

```console
$ perch scan --since origin/main
cart.py
  ID        Line  Severity  Type    Confidence  Problem             Method
  48a02173    15  P1 (1.0)  defect         88%  wrong_return_value  apply_discount
  44c8d48a    21  P1 (1.3)  defect         86%  inverted_condition  is_eligible_for_free_shipping
  80d6ebbb    28  P1 (1.3)  defect         91%  unhandled_null      cheapest

✖ 3 problems in 1 file, all failing
order-service at commit e648e44: 4 methods, read 3
3 requests  4k tokens in / 439 out  $0.0012
```

Note: GitHub doesn't issue OIDC tokens to pull requests from forks. To skip those pull requests, add this condition to
the job:

```yaml
    if: github.event.pull_request.head.repo.full_name == github.repository
```

## GitLab CI

To run Perch in GitLab CI, first create a CI token for the repository in the Perch Cloud dashboard. Add the token to your
GitLab project as a masked CI/CD variable named `PERCH_API_KEY`, then add this job to `.gitlab-ci.yml`:

```yaml
perch:
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: 0
  script:
    - git fetch origin $CI_MERGE_REQUEST_TARGET_BRANCH_NAME
    - npx --yes @lakeday/perch scan --since origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME
```

You can use a CI token in the same way with any other CI provider. Perch reads it from `PERCH_API_KEY` whenever
`PERCH_BASE_URL` isn't set.

## Use your own model endpoint

If you don't want to use Perch Cloud, set `PERCH_BASE_URL` to your provider's endpoint and `PERCH_API_KEY` to your API
key. In GitHub Actions, store the key as a repository secret and pass both values to the scan step:

```yaml
      - run: npx --yes @lakeday/perch scan --since origin/${{ github.base_ref }}
        env:
          PERCH_BASE_URL: https://api.typesafe.ai/v1/systemone
          PERCH_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
```

With this setup, the job doesn't need the `id-token: write` permission, and the results are only shown in the job log.
For the list of supported endpoints, see [Environment](/cli/#environment).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The scan didn't find anything that fails it. |
| 1 | Perch couldn't run, or couldn't read some methods after retrying. |
| 2 | The command was invalid. |
| 3 | The scan found something that fails it. |

By default, any problem a scan reports fails the job. To change which types of problem a scan checks for, set
`scan_types` in `perch.yaml`. To report a rule without failing the job, set `gate: false` on it. For more information, see
[Gates](/rules/#gates).
