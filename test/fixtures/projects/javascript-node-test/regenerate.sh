#!/usr/bin/env bash
# Runs the suite the way CI does, with node --test and its own coverage, in a temporary copy, and writes what it reported to
# reports/: junit.xml from Node's junit reporter and lcov.info from its lcov reporter, with the copy's path made relative to the
# project root.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir "$work/app"
tar -C "$here" --exclude ./node_modules --exclude ./reports --exclude ./coverage -cf - . | tar -C "$work/app" -xf -
cd "$work/app"
app="$(pwd -P)"

npm install --no-audit --no-fund --no-package-lock --loglevel=error

status=0
node --test --experimental-test-coverage --test-coverage-include='src/**' \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=junit --test-reporter-destination="$work/junit.xml" \
  --test-reporter=lcov --test-reporter-destination="$work/lcov.info" || status=$?
echo "node --test exited $status"

relative() { sed -e "s#$app/##g" -e "s#$work/app/##g" -e "s#$app#.#g" -e "s#$work/app#.#g" "$1"; }
mkdir -p "$here/reports"
relative "$work/junit.xml" > "$here/reports/junit.xml"
relative "$work/lcov.info" > "$here/reports/lcov.info"
