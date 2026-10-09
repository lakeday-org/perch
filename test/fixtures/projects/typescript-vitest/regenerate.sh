#!/usr/bin/env bash
# Runs the project's own tests in a scratch copy and writes what they report into reports/: JUnit XML and LCOV.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

tar -C "$here" --exclude=node_modules --exclude=reports --exclude=coverage --exclude=dist -cf - . | tar -C "$work" -xf -
cd "$work"
npm install --no-audit --no-fund --loglevel=error
npx vitest run --coverage \
  --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml \
  --coverage.reporter=lcov --coverage.reportsDirectory=coverage

rm -rf "$here/reports"
mkdir -p "$here/reports"
cp reports/junit.xml "$here/reports/junit.xml"
cp coverage/lcov.info "$here/reports/lcov.info"
