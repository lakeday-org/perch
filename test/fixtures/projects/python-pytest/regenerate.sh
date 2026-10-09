#!/usr/bin/env bash
# Reruns tally's test suite as its CI does and rewrites reports/: pytest's JUnit XML and coverage.py's Cobertura XML.
# Needs a Python with pytest and pytest-cov on PATH, or PYTHON pointing at one: python3 -m pip install pytest pytest-cov
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
python="${PYTHON:-python3}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
rsync -a --exclude reports --exclude regenerate.sh --exclude expected.json "$here/" "$work/"
cd "$work"
mkdir -p reports
"$python" -m pytest -p no:cacheprovider \
  --junitxml=reports/junit.xml -o junit_family=xunit2 \
  --cov --cov-report=xml:reports/coverage.xml --cov-report=term
rm -rf "$here/reports"
mkdir -p "$here/reports"
cp reports/junit.xml reports/coverage.xml "$here/reports/"
