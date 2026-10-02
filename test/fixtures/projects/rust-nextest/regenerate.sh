#!/bin/sh
# Rewrites reports/ from a real run of this workspace's tests, in a copy so no target/ is left behind.
#
#   reports/junit.xml  what cargo-nextest writes under the `ci` profile in .config/nextest.toml (target/nextest/ci/junit.xml),
#                      from the same run cargo llvm-cov measures.
#   reports/lcov.info  cargo llvm-cov nextest over the whole workspace. llvm-cov writes absolute SF: paths; they are rewritten
#                      relative to this directory, and any other mention of the temporary copy's path is dropped the same way.
#
# Needs cargo, cargo-nextest and cargo-llvm-cov.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# A real path: on macOS mktemp hands out /var/..., which the tools report as /private/var/....
copy=$(cd "$work" && pwd -P)/relcheck
mkdir "$copy"
(cd "$here" && tar cf - --exclude ./target --exclude ./reports --exclude ./regenerate.sh .) | (cd "$copy" && tar xf -)

cd "$copy"
cargo llvm-cov nextest --workspace --profile ci --lcov --output-path "$work/lcov.info" < /dev/null

mkdir -p "$here/reports"
sed -e "s#$copy/##g" -e "s#$copy#.#g" "$copy/target/nextest/ci/junit.xml" > "$here/reports/junit.xml"
sed -e "s#^SF:$copy/#SF:#" -e "s#$copy/##g" "$work/lcov.info" > "$here/reports/lcov.info"
echo "wrote $here/reports/junit.xml and $here/reports/lcov.info"
