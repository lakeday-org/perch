#!/usr/bin/env bash
# Run before exposing the model key. The contribution stays in Git's object database:
# no package scripts, .env, symlinks, or cached Perch results are materialized.
set -euo pipefail

[[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] || { echo 'Expected a PR number' >&2; exit 1; }
[[ "$PR_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full lowercase commit SHA' >&2; exit 1; }

pr=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER")
jq -e --arg sha "$PR_SHA" --arg repo "$GITHUB_REPOSITORY" \
  '.state == "open" and .head.sha == $sha and .base.repo.full_name == $repo' \
  <<< "$pr" >/dev/null || { echo 'PR is closed or its head changed; approve the current commit in a new run' >&2; exit 1; }
base_sha=$(jq -r '.base.sha' <<< "$pr")
[[ "$base_sha" =~ ^[0-9a-f]{40}$ ]]

target=$(mktemp -d "$RUNNER_TEMP/perch-pr.XXXXXX")
git init --quiet "$target"
git -C "$target" remote add origin "https://github.com/$GITHUB_REPOSITORY.git"
git -C "$target" fetch --no-tags origin "$base_sha"
git -C "$target" fetch --no-tags origin "refs/pull/$PR_NUMBER/head"
actual=$(git -C "$target" rev-parse FETCH_HEAD)
[[ "$actual" == "$PR_SHA" ]] || { echo 'PR changed during preparation; start a new run' >&2; exit 1; }
git -C "$target" update-ref HEAD "$PR_SHA"
printf 'target=%s\nbase_sha=%s\n' "$target" "$base_sha" >> "$GITHUB_OUTPUT"
