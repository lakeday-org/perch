#!/usr/bin/env bash
# Rewrites reports/ from a real run. The project is copied to a temporary directory, built with gcov instrumentation, and its
# doctest binary run once writing JUnit XML; gcovr then writes Cobertura from the gcov data that run left, with paths relative
# to the project root. The only change after a tool wrote a file is the temporary copy's path made relative.
#
# Needs CMake, a C++17 compiler, doctest where find_package(doctest) finds it, and gcovr.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
copy="$(cd "$scratch" && pwd -P)/throttle"
mkdir "$copy"
(cd "$here" && tar cf - --exclude ./reports --exclude ./build --exclude ./.perch .) | (cd "$copy" && tar xf -)

cmake -S "$copy" -B "$copy/build" -DCMAKE_BUILD_TYPE=Debug -DTHROTTLE_COVERAGE=ON
cmake --build "$copy/build" --parallel

# A failing test makes the binary exit 1, and that run is the one to report.
status=0
(cd "$copy" && ./build/throttle_tests -r=junit --out="$copy/junit.xml") || status=$?
if [ "$status" -gt 1 ]; then echo "throttle_tests exited $status" >&2; exit "$status"; fi

(cd "$copy" && gcovr --root . --filter 'src/' --filter 'include/' --cobertura cobertura.xml --cobertura-pretty build)

mkdir -p "$here/reports"
for report in junit.xml cobertura.xml; do
  sed -e "s#$copy/##g" -e "s#$copy#.#g" "$copy/$report" > "$here/reports/$report"
done
echo "wrote $here/reports/junit.xml and cobertura.xml"
