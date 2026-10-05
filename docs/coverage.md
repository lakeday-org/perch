---
title: Test coverage
nav: Test coverage
group: Using perch
order: 5.5
summary: Find unit tests of low value and discover the real coverage gaps in your code.
---

# Test coverage

Perch Coverage finds the bugs your tests would not catch, and the tests that
catch nothing. It reads every test and every function in your repository, and
follows each test through the call graph to the methods it reaches. Then it
plants bugs in those methods. For each bug and each test that reaches the
method, it asks a model whether that test would fail with the bug in.

A planted bug is one line changed: a comparison moved to its boundary (`<` to
`<=`), a condition negated, `&&` swapped for `||`, a `!` dropped, `+` swapped
for `-`, a boolean flipped, a returned number zeroed. These are the edits a
developer makes by mistake, and the ones mutation testers have planted for
decades. Perch runs no tests. The model reads the method with the edit marked
and each test with what it reaches, then says whether the test would notice.

Point it at a repository:

```console
$ perch coverage
Source files      Methods tested     Bugs caught  Uncaught bugs
src/cart.ts               2 of 2    71% (5 of 7)              2
src/checkout.ts           1 of 1   100% (2 of 2)              0
src/inventory.ts          1 of 1   100% (4 of 4)              0
All source                4 of 4  85% (11 of 13)              2

Test files                    Quality  Duplicates  Checks nothing  Live services
test/cart.test.ts        43% (3 of 7)           4               0              1
test/checkout.test.ts   100% (1 of 1)           0               0              0
test/inventory.test.ts  100% (4 of 4)           0               0              0
All tests               67% (8 of 12)           4               0              1

src/cart.ts
  ID        Line  Problem   Confidence  Test or method  Note
  5463a88e    12  uncaught         60%  applyDiscount   With `>` instead of `>=`, none of the 5 tests reaching it…
  19e3def8    12  uncaught         59%  applyDiscount   With `1` instead of `0`, none of the 5 tests reaching it …

test/cart.test.ts
  ID        Line  Problem    Confidence  Test or method              Note
  d0eacd17    10  redundant         95%  applyDiscount > takes 20 …  Catches the same planted bugs as applyDiscou…
  7ff46fdf    14  redundant         95%  applyDiscount > takes 25 …  Catches the same planted bugs as applyDiscou…
  3055e1ad    18  redundant         95%  applyDiscount > takes 50 …  Catches the same planted bugs as applyDiscou…
  427fce7a    22  redundant         95%  applyDiscount > takes 75 …  Catches the same planted bugs as applyDiscou…
  472ae559    32  infra             88%  subtotal > matches the to…  Calls a live service with nothing mocked: fe…
shop at commit 8680c01: 4 methods, 12 tests, 7 problems
Report: .perch/coverage/index.html
14 requests  0 tokens in  $0.0000
```

Bugs caught is the planted bugs some test is predicted to fail on, of every bug
planted. Methods tested is how many methods some test reaches through the call
graph. Uncaught bugs are the ones no test catches, each listed with the edit
and how many tests miss it. The confidence is how sure the model is: that no
test catches the bug, and that the bug would change what a caller sees. Checks
nothing is a test that catches none of the bugs planted in the code it reaches.
Duplicates are tests that catch exactly the bugs an earlier test catches. A
problem with `-` belongs to a test or method the model could not be asked
about. `--all` lists every row. The HTML report shows the source with each
problem under its line: an uncaught bug is shown as the line as written and as
changed, with the tests that still pass. It is one file, unless the repository
has more than 8 MB of source. Then each file gets its own page under `files/`,
next to `index.html`.

## How it differs from a coverage report

A coverage report tells you which lines your tests ran. A line that ran is not
a line that was checked: a test can call a method, assert nothing about the
result, and still turn every line it touched green.

A mutation tester such as Stryker or PIT plants bugs the way Perch does, then
runs your whole test suite against each one, which takes hours on a large
repository and needs the toolchain set up to run. Perch asks a model instead of
running anything, so a run takes minutes, works on code you cannot run locally,
and works on a pull request in CI with no test job. It reads nothing your CI
writes: no coverage report, no test results. The model's answer is a
prediction, and the confidence says how sure it is.

Perch only considers the code that your test frameworks will actually run. It
does this by loading your Vitest or Jest config or reading your pytest and
coverage.py settings, and excluding things like scripts, examples and docs
tooling that can't be covered by tests. When run on a branch, Perch lists the
problems in code the branch changed.

## What gets planted

Each reached method gets up to ten planted bugs, the most telling first:
comparison boundaries, swapped connectives, negated conditions, dropped `!`,
arithmetic operators, flipped booleans, zeroed returns. A method with no such
line, a one-line delegate or a getter, gets none, and counts as reached with
nothing to catch. A method no test reaches gets none either: it is listed as
untested, and the model is asked whether it needs a test at all.

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

`--verbose` says which frameworks decided it:

```
$ perch coverage --verbose
...
[perch] Vitest 2.1.9 (package.json) runs 3 test files
```

A config that cannot load is named on the last line, and perch reads every test
it finds instead. `--verbose` gives the error. `ignore:` in `perch.yaml` leaves out more on top.

## Supported languages and frameworks

| Language | Frameworks |
| --- | --- |
| Python | pytest, unittest |
| JavaScript, TypeScript, TSX | Vitest, Jest, Mocha, node:test |
| Rust | libtest, nextest |
| Java | JUnit 5, JUnit 4, TestNG |
| C++ | GoogleTest, Catch2 v3, doctest |

Other languages are not supported yet. A test in a framework perch does not
recognize is not found.

## Checking a branch

`--since REF` lists the problems in methods and tests the branch changed:

```console
$ perch coverage --since main
src/cart.ts
  ID        Line  Problem   Confidence  Test or method  Note
  5463a88e    12  uncaught         59%  applyDiscount   With `>` instead of `>=`, none of the 5 tests reaching it…
  19e3def8    12  uncaught         57%  applyDiscount   With `1` instead of `0`, none of the 5 tests reaching it …

test/cart.test.ts
  ID        Line  Problem    Confidence  Test or method              Note
  427fce7a    22  redundant         96%  applyDiscount > takes 75 …  Catches the same planted bugs as applyDiscou…
shop at commit 76f8d50: 4 methods, 12 tests, 3 problems in changed code, 4 elsewhere
Report: .perch/coverage/index.html
14 requests  0 tokens in  $0.0000
```

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

Each run is saved under `.perch/coverage`. The report from the next run at
another commit shows what changed. `--diff REF` compares with the run saved at that commit and prints
the change in each file.

`perch coverage` exits 3 when it lists a problem and 1 when it could not run.
