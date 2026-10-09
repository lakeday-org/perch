#!/usr/bin/env bash
# Runs the real Maven build in a copy of this project and rewrites reports/ from what it wrote: Surefire's JUnit XML, one file
# per test class, and the JaCoCo XML report. Needs JDK 21 and Maven 3.9 on PATH.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

rsync -a --exclude reports --exclude target --exclude expected.json --exclude regenerate.sh "$here/" "$work/"
(cd "$work" && mvn --batch-mode --quiet test)

rm -rf "$here/reports"
mkdir -p "$here/reports/junit"
cp "$work"/target/surefire-reports/TEST-*.xml "$here/reports/junit/"
cp "$work/target/site/jacoco/jacoco.xml" "$here/reports/jacoco.xml"

# The reports name the machine they ran on: the temporary copy, the home directory, the user. Keep the run, not the machine.
real="$(cd "$work" && pwd -P)"
find "$here/reports" -name '*.xml' -exec perl -pi -e '
  BEGIN { ($real, $work, $home, $tmp) = splice @ARGV, 0, 4 }
  s/\Q$real\E/./g; s/\Q$work\E/./g; s/\Q$tmp\E/\/tmp\//g; s/\Q$home\E/~/g;
  s/(name="user\.name" value=")[^"]*/${1}fixture/g;
' "$real" "$work" "$HOME" "${TMPDIR:-/tmp/}" {} +
