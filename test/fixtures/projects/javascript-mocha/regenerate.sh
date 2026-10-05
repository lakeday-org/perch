#!/usr/bin/env bash
# Runs the suite the way CI does, under c8 with mocha-junit-reporter (configured in .mocharc.json), in a temporary copy, and
# writes what it reported to reports/: junit.xml and lcov.info, with the copy's path made relative to the project root.
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
MOCHA_FILE="$work/junit.xml" npx c8 --report-dir="$work/coverage" --reporter=lcovonly mocha || status=$?
echo "mocha exited $status"

relative() { sed -e "s#$app/##g" -e "s#$work/app/##g" -e "s#$app#.#g" -e "s#$work/app#.#g" "$1"; }
mkdir -p "$here/reports"
relative "$work/junit.xml" > "$here/reports/junit.xml"
relative "$work/coverage/lcov.info" > "$here/reports/lcov.info"
