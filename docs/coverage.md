---
title: Test coverage
nav: Test coverage
group: Using perch
order: 5.5
summary: Find unit tests of low value and discover the real coverage gaps in your code.
---

# Test coverage

Perch Coverage tells you which of your existing unit tests aren’t useful and
where you have holes in test coverage. Perch reads every test and every function
in your repository. It follows each test through the call graph to the methods
it reaches. Then it uses a model to figure out what each test is actually
testing.

If your CI writes test results and a coverage report, Perch reads those too, and
its numbers are measured. Test results are JUnit XML, which pytest, Vitest,
Jest, nextest, Maven, Gradle and GoogleTest can all write. The coverage report
can be LCOV, Cobertura, JaCoCo or coverage.py's. Without them, Perch estimates
from the call graph and marks each estimate `est.`

Perch will identify tests that don’t have any assertions, tests that just test
that a mock returns what you told it to return, tests that are duplicating other
tests, and tests that hit the disk or network without mocking. For each method
that your tests run, Perch will tell you the most important branch that isn’t
being tested, and what kind of input you need to write a test for that branch.
For each method that isn’t run by any tests, Perch will tell you whether it
needs to be tested or not.

Point `perch coverage` at the JUnit XML and coverage report your CI already
writes, and its numbers are measured:

```console
$ perch coverage --junit reports/vitest/junit.xml --lcov reports/vitest/lcov.info
Source files      Methods tested  Lines  Branches  Untested branches
src/cart.ts               2 of 2   100%       75%                  1
src/checkout.ts           1 of 1   100%       50%                  1
src/inventory.ts          1 of 1   100%       75%                  1
All source                4 of 4   100%       70%                  3

Test files                    Quality  Duplicates  Weak  Unmocked I/O  Time
test/cart.test.ts        71% (5 of 7)           0     2             1   4ms
test/checkout.test.ts   100% (1 of 1)           0     0             0   1ms
test/inventory.test.ts   75% (3 of 4)           0     1             0   1ms
All tests               75% (9 of 12)           0     3             1   6ms

src/cart.ts
  ID        Line  Problem    Confidence  Test or method  Note
  d0bee7da    12  edge_case        100%  applyDiscount   Untested case: applyDiscount at the edge…

src/checkout.ts
  ID        Line  Problem    Confidence  Test or method  Note
  7087f25c     6  edge_case        100%  placeOrder      Untested case: placeOrder failing.

src/inventory.ts
  ID        Line  Problem    Confidence  Test or method  Note
  49b7e108     6  edge_case         83%  canFulfil       Untested case: canFulfil with input in a…

test/cart.test.ts
  ID        Line  Problem        Confidence  Test or method       Note
  f5aebe0a    28  no_assertion         100%  subtotal > adds up…  Asserts nothing.
  12d6d00b    32  mystery_guest         99%  subtotal > matches…  Uses a file, record or service …
  472ae559    32  infra                 97%  subtotal > matches…  Touches the network and environ…

test/inventory.test.ts
  ID        Line  Problem       Confidence  Test or method       Note
  3ca3cd17    23  asserts_mock         98%  canFulfil > return…  Checks a value its own mock retu…
Dropping 3 duplicate or weak tests saves 4ms of 6ms and leaves every method reached.
Tests are the ones Vitest 2.1.9 (its defaults) runs; 0 files no test framework covers are left out
.perch/coverage/index.html
19 requests  0 tokens in  $0.0000
```

The call graph and the coverage report find each problem. The percentage is how
sure the model is that it needs fixing. A problem with `-` belongs to a test or
method the model could not be asked about. `--all` lists every row. The HTML
report shows the source with each problem under its line. It is one file, unless
the repository has more than 8 MB of source. Then each file gets its own page
under `files/`, next to `index.html`.

## How it differs from a coverage report

A coverage report just tells you what lines were run by your tests. But just
because a line was run doesn’t mean it was tested. It’s easy to write tests that
will pass no matter what the code does, and get 90% coverage while testing
nothing.

Perch reads your coverage report for you, and tells you whether the lines that
were run were actually tested. And for branches that weren’t run, Perch tells
you which ones you should actually worry about, and what you need to do to run
each branch. Rather than giving you a single coverage percentage, Perch gives
you a list of specific problems, with the file and line number of each problem,
and a confidence score for how sure it is that it’s actually a problem.

Perch only considers the code that your test frameworks will actually run. It
does this by loading your Vitest or Jest config or reading your pytest and
coverage.py settings, and excluding things like scripts, examples and docs
tooling that can’t be covered by tests. When run on a branch, Perch will tell
you how many of the lines that were changed on the branch were run by tests, and
highlight which problems were found in code that was changed on the branch.

## What it reads

`perch coverage` reads the code your test frameworks run and measure, and
leaves out the rest: release scripts, examples, docs tooling, CI actions.

- **Vitest and Jest:** perch loads the config with your installed copy, the
  way the framework does. The tests are the ones it would run. Its coverage
  `include` and `exclude` decide the source; without an `include`, the source
  is what those tests import and the files beside them. Install your
  dependencies before running it, as for the tests themselves.
- **pytest:** `testpaths` and `python_files` from `pytest.ini`,
  `pyproject.toml`, `tox.ini` or `setup.cfg`, and coverage.py's `source` and
  `omit`.
- **Go, Rust, Java, Kotlin, C++ and the rest:** perch only reports coverage
  for the module that the test is in. That might be a Go module, a crate, a
  Gradle module, or something else. perch includes all the code that the module
  builds: all of `src/` in a crate, all of `src/main/` in a Maven or Gradle
  module, and all code outside of `tools/`, `bench/`, `examples/`, `samples/`,
  `scripts/`, or `docs/` in any other project.

The last lines of the output say which frameworks decided it:

```
$ perch coverage --paths lib/helpers/combineURLs.js
...
Tests are the ones Vitest 4.1.11 (vitest.config.js), Vitest 4.1.11 (tests/module/esm/vitest.config.js), Vitest 4.1.11 (tests/smoke/esm/vitest.config.js) run; 70 files no test framework covers are left out
```

A config that cannot load is named with the error, and perch reads every test
it finds instead. `ignore:` in `perch.yaml` leaves out more on top.

## Reading your CI's reports

Name the files with flags, or list them in `perch.yaml` so every run finds them.
A glob names every file it matches, and a glob that matches nothing is an error.

```yaml
coverage_reports:
  junit: [reports/junit/*.xml]
  lcov: [coverage/lcov.info]
```

| Flag | Report | What it gives |
| --- | --- | --- |
| `--junit` | JUnit XML | Each test's time and result |
| `--lcov` | LCOV | Line and branch hits, and per-test lines when each test has its own `TN:` record |
| `--cobertura` | Cobertura XML | Line and branch hits |
| `--jacoco` | JaCoCo XML | Line and branch hits |
| `--contexts` | coverage.py JSON from `coverage json --show-contexts` | Line and branch hits, and the lines each test ran |

A run perch cannot match to a test is listed as unmatched and counted on stderr.
It is never guessed.

## Supported languages and frameworks

| Language | Framework | JUnit XML from | Coverage from | Setting perch needs |
| --- | --- | --- | --- | --- |
| Python | pytest | `--junitxml` | coverage.py, with `--cov-context=test` for per-test lines | |
| Python | unittest | unittest-xml-reporting | coverage.py | `dynamic_context = test_function` for per-test lines |
| JavaScript, TypeScript, TSX | Vitest | `--reporter=junit` | V8, as LCOV or Cobertura | |
| JavaScript, TypeScript, TSX | Jest | jest-junit | Istanbul, as LCOV or Cobertura | jest-junit: `addFileAttribute: "true"`, `ancestorSeparator: " > "`, `classNameTemplate: "{classname}"`, `titleTemplate: "{title}"` |
| JavaScript, TypeScript | Mocha | mocha-junit-reporter | c8, as LCOV | `jenkinsMode: true`, `suiteTitleSeparatedBy: " > "` |
| JavaScript, TypeScript | node:test | `--test-reporter=junit` | `--test-reporter=lcov` | |
| Rust | libtest | `-Z unstable-options --format junit --report-time` | cargo-llvm-cov, as LCOV | `--report-time`, or every time reads 0 |
| Rust | nextest | a profile with JUnit output | cargo-llvm-cov, as LCOV | |
| Java | JUnit 5 | Maven Surefire or Gradle | JaCoCo XML | Gradle, for a class with more than one `@ParameterizedTest`: `junit.jupiter.params.displayname.default = {displayName} [{index}] {arguments}` in `junit-platform.properties` |
| Java | JUnit 4 | Maven Surefire | JaCoCo XML | |
| Java | TestNG | Maven Surefire | JaCoCo XML | |
| C++ | GoogleTest | `--gtest_output=xml` | gcovr, as Cobertura or LCOV | |
| C++ | Catch2 v3 | `-r junit` | gcovr | `--warn NoAssertions`, or a test with no assertion has no run |
| C++ | doctest | `-r=junit` | gcovr | |

Other languages are not supported yet. A test in a framework perch does not
recognize is not found, and its runs are listed as unmatched.

## Checking a branch

`--since REF` lists each source file the branch changed where the tests missed
a changed line of code, and how many they missed. The share of changed lines of
code that ran is patch coverage. The problems below it are the ones in methods
and tests the branch changed:

```console
$ perch coverage --since main --junit reports/vitest/junit.xml --lcov reports/vitest/lcov.info
Changed since main  Untested lines  Patch coverage
src/main.ts                      1              0%
All changed source               1             50%

src/cart.ts
  ID        Line  Problem    Confidence  Test or method  Note
  d0bee7da    12  edge_case        100%  applyDiscount   Untested case: applyDiscount at the edge…
Dropping 3 duplicate or weak tests saves 4ms of 6ms and leaves every method reached.
Tests are the ones Vitest 2.1.9 (its defaults) runs; 0 files no test framework covers are left out
Whole repository: 4 of 4 methods reached, 100% of lines ran, 6 problems in code this branch did not change
.perch/coverage/index.html
```

Changed comments and blank lines are not counted. A file no coverage report
covers shows `not measured`. Test files are left out of the table.

With `--since`, perch exits 3 only for a problem in changed code. It compares
with a saved run only when `--diff` names one.

## Fixing and dismissing problems

Each problem in the HTML report has a Copy fix prompt button. The prompt names
the problem, its file and line, the evidence, and the change to make. Paste it
into your coding agent.

`perch close <id> --reason "..."` sets a problem aside, and later runs leave it
out. `perch reopen <id>` lists it again. The Dismiss button in the report copies
that command and hides the problem on the page.

## Comparing runs

Each run is saved under `.perch/coverage`. The next run at another commit says
what changed. `--diff REF` compares with the run saved at that commit and prints
the change in each file.

`perch coverage` exits 3 when it lists a problem and 1 when it could not run.
