---
title: Test coverage
nav: Test coverage
group: Using perch
order: 5.5
summary: Find unit tests of low value and discover the real coverage gaps in your code.
---

# Test coverage

Perch Coverage finds low-value unit tests and the real gaps in your test
coverage. It is predictive mutation testing. Perch generates mutants of every
method your tests reach and, for each mutant, asks a decision model, Jev, which
of those tests would fail with the mutant in place. Perch does not run any
tests, and does not change any files.

A mutant is a change to one line of one method. Perch replaces `<` with `<=`,
`&&` with `||`, negates a condition, removes a `!`, replaces `+` with `-`, flips
a boolean, returns `0` instead of a number: the same operators Stryker and PIT
use. If a test fails with a mutant in place, the test kills that mutant. If
every test passes with a mutant in place, that mutant survives. Each survived
mutant is a real gap in your coverage: a test runs that line, but nothing checks
that it does the right thing.

Point it at a repository:

```console
$ perch coverage
Source files      Methods tested  Mutation score  Survived
src/cart.ts               2 of 2    71% (5 of 7)         2
src/checkout.ts           1 of 1   100% (2 of 2)         0
src/inventory.ts          1 of 1   100% (4 of 4)         0
All source                4 of 4  85% (11 of 13)         2

Test files                    Quality  Duplicates  Checks nothing  Live services
test/cart.test.ts        43% (3 of 7)           4               0              1
test/checkout.test.ts   100% (1 of 1)           0               0              0
test/inventory.test.ts  100% (4 of 4)           0               0              0
All tests               67% (8 of 12)           4               0              1

src/cart.ts
  ID        Line  Problem   Confidence  Test or method  Note
  3945b1f7    12  survived         62%  applyDiscount   With `>` instead of `>=`, none of the 5 tests reaching it…
  d6f68653    12  survived         57%  applyDiscount   With `1` instead of `0`, none of the 5 tests reaching it …

test/cart.test.ts
  ID        Line  Problem    Confidence  Test or method              Note
  d0eacd17    10  redundant         95%  applyDiscount > takes 20 …  Kills the same mutants as applyDiscount > ta…
  7ff46fdf    14  redundant         95%  applyDiscount > takes 25 …  Kills the same mutants as applyDiscount > ta…
  3055e1ad    18  redundant         95%  applyDiscount > takes 50 …  Kills the same mutants as applyDiscount > ta…
  427fce7a    22  redundant         95%  applyDiscount > takes 75 …  Kills the same mutants as applyDiscount > ta…
  472ae559    32  infra             88%  subtotal > matches the to…  Calls a live service with nothing mocked: fe…
shop at commit 8f797f0: 4 methods, 12 tests, 7 problems
Report: .perch/coverage/index.html
14 requests  22k tokens in / 1k out  $0.0064
```

The mutation score is the share of mutants killed by at least one test. Methods
tested is the number of methods at least one test reaches through the call
graph. Perch lists each survived mutant with the edit it made and the number of
tests that miss it. The confidence is how sure Perch is that no test kills the
mutant and that the mutant changes what a caller sees. A test that checks
nothing kills no mutant in the code it reaches. A duplicate kills exactly the
mutants an earlier test kills. A problem with a `-` for confidence is on a test
or method the model couldn't be asked about. Use `--all` to see every row.

Perch also writes an HTML report. It shows each line of source with its problems
under it. For a survived mutant, it shows the original and the mutated version
of the line, and the tests that still pass. The report is one file, unless your
repository has more than 8 MB of source. Then each file gets its own page in
the `files/` directory next to `index.html`.

## How it differs from a coverage report

A coverage report tells you which lines your tests ran. A line that ran is not a
line that was checked: a test can call a method, assert nothing about the
result, and still turn every line it touched green. Mutation testing asks the
question coverage can't: if this line were wrong, would any test notice?

Mutation testing tools like Stryker and PIT run your entire test suite against
each mutant. That takes hours on a large repository, and you have to set up
their toolchain first. Perch predicts what your tests would do against each
mutant, without running any of them. So Perch can read any repository in a few
minutes, even one you can't build locally, and you can run it on a pull request
in CI without a test job. Perch reads no CI output: no coverage reports, no test
results. It predicts the test results and shows how confident it is in each
prediction.

Perch only looks at the code your test frameworks run. It loads the same config
files as Vitest, Jest, pytest and coverage.py, which lets it ignore scripts,
examples and docs tooling that no test covers. On a branch, Perch only lists
problems in changed code.

## What gets mutated

Perch creates up to ten mutants for each method your tests reach. It tries the
most telling mutations first: boundary values in comparisons, swapping
connectives like `&&` and `||`, negating conditions, dropping `!`, changing
arithmetic operators, flipping booleans, and returning `0`. If perch can't find
a line to mutate in the method, because it's a one-line delegation or a getter,
it creates zero mutants. Perch counts the method as reached, but there's nothing
to kill. If your tests don't reach the method, perch also creates zero mutants,
and the method counts against Methods tested. Perch doesn't list it as a
problem, because it can't know whether the method needs a test from the call
graph alone.

## What it reads

`perch coverage` reads the code your test frameworks run and measure. It
ignores release scripts, examples, documentation tooling and CI actions.

- **Vitest and Jest:** perch loads your configuration using the copy of the
  framework you've installed, so it runs over the same tests the framework
  would run. The coverage configuration's `include` and `exclude` options decide
  which files are source code. If you don't have an `include` option, the
  source is the code your tests import, plus the files beside your tests.
  Install your dependencies before running perch, as you would for the tests.
- **pytest:** perch reads the `testpaths` and `python_files` options from
  `pytest.ini`, `pyproject.toml`, `tox.ini` or `setup.cfg`, and the `source`
  and `omit` options from your coverage.py configuration.
- **Go, Rust, Java, Kotlin, C++ and the rest:** perch only reports coverage
  for the module that contains the test. A module may be a Go module, a Rust
  crate, a Gradle module, or something else. In a Rust crate, perch includes
  all of the code in `src/`. In a Maven or Gradle module, all of the code in
  `src/main/`. In any other project, all of the code that is not in a directory
  named `tools/`, `bench/`, `examples/`, `samples/`, `scripts/` or `docs/`.

Perch tells you which frameworks it decided on when you run it with
`--verbose`:

```
$ perch coverage --verbose
...
[perch] Vitest 2.1.9 (package.json) runs 3 test files
```

If perch can't load a configuration, it names that configuration on the last
line and reads every test it can find instead. `--verbose` shows the error. You
can leave out more files and directories with the `ignore:` option in
`perch.yaml`.

## Supported languages and frameworks

| Language | Frameworks |
| --- | --- |
| Python | pytest, unittest |
| JavaScript, TypeScript, TSX | Vitest, Jest, Mocha, node:test |
| Rust | libtest, nextest |
| Java | JUnit 5, JUnit 4, TestNG |
| C++ | GoogleTest, Catch2 v3, doctest |

Perch doesn't support other languages yet. If you write a test in a framework
perch doesn't recognize, perch won't find it.

## Checking a branch

Run perch with `--since REF` to list the problems in methods and tests you've
changed on the branch:

```console
$ perch coverage --since main
src/cart.ts
  ID        Line  Problem   Confidence  Test or method  Note
  3945b1f7    12  survived         60%  applyDiscount   With `>` instead of `>=`, none of the 5 tests reaching it…
  d6f68653    12  survived         58%  applyDiscount   With `1` instead of `0`, none of the 5 tests reaching it …

test/cart.test.ts
  ID        Line  Problem    Confidence  Test or method              Note
  427fce7a    22  redundant         96%  applyDiscount > takes 75 …  Kills the same mutants as applyDiscount > ta…
shop at commit 861c607: 4 methods, 12 tests, 3 problems in changed code, 4 elsewhere
Report: .perch/coverage/index.html
14 requests  12k tokens in / 666 out  $0.0036
```

With `--since`, perch exits 3 only when it finds a problem in changed code. It
compares the results with a previous run only when you also pass `--diff` to say
which run.

## Fixing and dismissing problems

Each problem in the HTML report has a Copy fix prompt button. The prompt tells
your coding agent what the problem is, which file and line it's on, what
evidence there is for it, and what to change. Paste it in.

You can close a problem with `perch close <id> --reason "..."`. Later runs of
`perch coverage` won't list it. You can reopen it with `perch reopen <id>`. The
Dismiss button in the report copies the close command and hides the problem on
the page.

## Comparing runs

Perch saves each run under `.perch/coverage`. When you run it again at another
commit, the HTML report shows how the results changed. On the command line,
`--diff REF` compares with the run saved at that commit and prints the change in
each file.

`perch coverage` exits with code 3 when it lists a problem and 1 when it could
not run.
