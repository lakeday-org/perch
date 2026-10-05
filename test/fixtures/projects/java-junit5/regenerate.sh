#!/usr/bin/env bash
# Runs the real Gradle build in a copy of this project and rewrites reports/ from what it wrote: each module's JUnit XML from
# Gradle's test task and its JaCoCo XML from jacocoTestReport. Needs JDK 21 and Gradle 9 on PATH.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

rsync -a --exclude reports --exclude build --exclude .gradle --exclude expected.json --exclude regenerate.sh "$here/" "$work/"
(cd "$work" && gradle --no-daemon --quiet test jacocoTestReport)

rm -rf "$here/reports"
for module in core api; do
  mkdir -p "$here/reports/$module/junit"
  cp "$work/$module"/build/test-results/test/TEST-*.xml "$here/reports/$module/junit/"
  cp "$work/$module/build/reports/jacoco/test/jacocoTestReport.xml" "$here/reports/$module/jacoco.xml"
done

# The reports name the machine they ran on: the temporary copy, the home directory, the user. Keep the run, not the machine.
real="$(cd "$work" && pwd -P)"
find "$here/reports" -name '*.xml' -exec perl -pi -e '
  BEGIN { ($real, $work, $home, $tmp) = splice @ARGV, 0, 4 }
  s/\Q$real\E/./g; s/\Q$work\E/./g; s/\Q$tmp\E/\/tmp\//g; s/\Q$home\E/~/g;
  s/(name="user\.name" value=")[^"]*/${1}fixture/g;
' "$real" "$work" "$HOME" "${TMPDIR:-/tmp/}" {} +
