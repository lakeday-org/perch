#!/usr/bin/env bash
# Reruns governor's test suite as its CI does and rewrites reports/: unittest-xml-reporting's JUnit XML, and coverage.py's
# LCOV and JSON with each test's lines recorded under its own context (dynamic_context = test_function in pyproject.toml).
# Needs a Python with coverage and unittest-xml-reporting, or PYTHON pointing at one: python3 -m pip install coverage unittest-xml-reporting
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
python="${PYTHON:-python3}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
rsync -a --exclude reports --exclude regenerate.sh --exclude expected.json "$here/" "$work/"
cd "$work"
mkdir -p reports
"$python" -m coverage run -m xmlrunner discover -s tests -t . --output-file reports/junit.xml
"$python" -m coverage lcov -o reports/lcov.info
"$python" -m coverage json --show-contexts --pretty-print -o reports/coverage.json
"$python" -m coverage report
rm -rf "$here/reports"
mkdir -p "$here/reports"
cp reports/junit.xml reports/lcov.info reports/coverage.json "$here/reports/"
