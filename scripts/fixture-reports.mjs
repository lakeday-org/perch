/**
 * Regenerates test/fixtures/<app>/reports/<runner>/: the files each fixture application's CI would write when it runs its tests
 * under coverage. JUnit XML, a line-and-branch coverage report, and per-test coverage where the ecosystem has it.
 *
 * Every file here is written by the application's own test runner and coverage tool, run on this machine against a
 * temporary copy of the application. The fixture sources are never touched, and nothing is written by hand.
 *
 * One post-processing step is applied, and only one: the temporary copy's absolute path is rewritten to be relative to the
 * application root. `<copy>/src/cart.rs` becomes `src/cart.rs`, and `<copy>` on its own (a Cobertura <source>) becomes `.`.
 * Both the path as created and its resolved form are rewritten, since /tmp and /var are symlinks on macOS. Nothing else in
 * any report is changed. The Rust per-test LCOV, which no tool writes as one file, is assembled as described next.
 *
 * The Rust per-test LCOV is assembled from one `cargo llvm-cov` run per test. Each run's tracefile is kept unchanged apart
 * from the path rewrite, with a `TN:` line inserted before each of its `SF:` records and a final newline added where
 * llvm-cov ends its last record without one. The tracefiles are concatenated in the order `cargo test -- --list` gives.
 * A TN is the libtest test name, which is the test's module path inside the crate and its function name, with every `::`
 * replaced by `__`: `tests::takes_ten_percent_off` is `tests__takes_ten_percent_off`. LCOV allows only letters, digits
 * and underscores in a TN, so a name that would produce anything else, or two tests that would produce the same TN, stop
 * the run. Map a test to its TN, not a TN back to a test.
 *
 * libtest's JUnit formatter writes time="0" for every test unless it is asked to measure with --report-time, so it is.
 *
 * Tests fail where the fixtures are designed to fail: no database, no price service, no credentials. The environment
 * variables the fixtures read are removed from the test environment so every run fails the same way. A failing test still
 * produces its JUnit record, so a nonzero exit from a test run is expected; a report the run did not write is an error.
 *
 * Environment:
 *   PERCH_FIXTURE_PYTHON          a Python with pytest, pytest-cov, coverage and unittest-xml-reporting installed (default python3)
 *   PERCH_FIXTURE_RUST_TOOLCHAIN  the nightly toolchain for libtest JUnit and branch coverage (default nightly)
 *   LLVM_COV, LLVM_PROFDATA       read by cargo-llvm-cov when the toolchain has no llvm-tools-preview component
 *   PERCH_FIXTURE_JAVA_HOME       the JDK Maven and Gradle build and test with (default JAVA_HOME, else java on PATH)
 *
 * Tools each family needs on PATH: npm (JavaScript and TypeScript); cargo, cargo-llvm-cov and cargo-nextest (Rust); Maven and
 * Gradle (Java); CMake, a C++ compiler, GoogleTest, Catch2, doctest and gcovr (C++).
 *   TMPDIR                        where the temporary copies go
 *
 * The C++ applications are built by CMake with gcov instrumentation and run once; gcovr writes Cobertura from the gcov data
 * that run left. Catch2 is run with `--warn NoAssertions`, without which its JUnit reporter writes nothing for a test case
 * that made no assertion.
 *
 * Java needs a JDK and Maven; C++ needs CMake, gcovr, and the application's framework where CMake's find_package finds it:
 * GoogleTest, Catch2 3 or doctest. Without them those applications are skipped, their existing reports/ is left as it is,
 * and the script says what was missing.
 *
 * Usage: node scripts/fixture-reports.mjs [app ...]
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyApp, fixtures } from './fixture-reports/common.mjs';
import { apps as pythonApps } from './fixture-reports/python.mjs';
import { apps as javascriptApps } from './fixture-reports/javascript.mjs';
import { apps as rustApps } from './fixture-reports/rust.mjs';
import { apps as jvmApps } from './fixture-reports/jvm.mjs';
import { apps as nativeApps } from './fixture-reports/native.mjs';

/** Every application's generator, one module per language family under scripts/fixture-reports/. */
const apps = { ...pythonApps, ...javascriptApps, ...rustApps, ...jvmApps, ...nativeApps };

const only = process.argv.slice(2);
for (const name of only) if (!apps[name]) throw new Error(`no fixture application named ${name}`);
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'perch-fixture-reports-')));
const written = [], skipped = [];
try {
  for (const [app, { missing, generate }] of Object.entries(apps)) {
    if (only.length && !only.includes(app)) continue;
    const absent = await missing(scratch);
    if (absent.length) {
      skipped.push(`${app}: needs ${absent.join(', ')}; test/fixtures/${app}/reports/ left as it is`);
      continue;
    }
    console.log(`${app}`);
    const files = await generate(await copyApp(scratch, app));
    const reports = join(fixtures, app, 'reports');
    await rm(reports, { recursive: true, force: true });
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(reports, path, '..'), { recursive: true });
      await writeFile(join(reports, path), text);
      written.push(`test/fixtures/${app}/reports/${path}`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log(`\nwrote\n${written.map(path => `  ${path}`).join('\n') || '  nothing'}`);
if (skipped.length) console.log(`skipped\n${skipped.map(line => `  ${line}`).join('\n')}`);
