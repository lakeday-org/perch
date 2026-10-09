#!/bin/sh
# Rewrites reports/ from a real run of this crate's tests, in a copy so no target/ is left behind.
#
#   reports/junit.xml  libtest's own JUnit, one document per test binary written back to back on stdout. The JUnit formatter is
#                      unstable, so RUSTC_BOOTSTRAP=1 lets a stable toolchain use it.
#   reports/lcov.info  cargo llvm-cov over the same tests. llvm-cov writes absolute SF: paths; they are rewritten relative to
#                      this directory, and any other mention of the temporary copy's path is dropped the same way.
#
# Needs cargo and cargo-llvm-cov (cargo install cargo-llvm-cov; rustup component add llvm-tools-preview).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# A real path: on macOS mktemp hands out /var/..., which the tools report as /private/var/....
copy=$(cd "$work" && pwd -P)/tiny-ledger
mkdir "$copy"
(cd "$here" && tar cf - --exclude ./target --exclude ./reports --exclude ./regenerate.sh .) | (cd "$copy" && tar xf -)

cd "$copy"
RUSTC_BOOTSTRAP=1 cargo test --quiet -- -Z unstable-options --format junit --report-time > "$work/junit.xml" < /dev/null
cargo llvm-cov --quiet --lcov --output-path "$work/lcov.info" < /dev/null

mkdir -p "$here/reports"
sed -e "s#$copy/##g" -e "s#$copy#.#g" "$work/junit.xml" > "$here/reports/junit.xml"
sed -e "s#^SF:$copy/#SF:#" -e "s#$copy/##g" "$work/lcov.info" > "$here/reports/lcov.info"
echo "wrote $here/reports/junit.xml and $here/reports/lcov.info"
