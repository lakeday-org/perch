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
method your tests reach. For each mutant, it asks a decision model, Jev, which
of those tests would fail with the mutant in place. Perch runs no tests and
changes no files.

A mutant is one edit to one method: a call statement removed, an `if` body
emptied, a condition forced to `true` or `false`, `<` to `<=`, `&&` to `||`,
`+` to `-`, `n++` to `n--`, a removed `!`, a flipped boolean, a string
emptied, a number moved by one, a returned value replaced. These are the
operators Stryker and PIT use. If a test fails with a mutant in place, the test
kills it. If every test passes, the mutant survives. A survived mutant is a
real gap in your coverage: a test runs that code, and nothing checks what it
does.

Point it at a repository:

```console
$ perch coverage
Source files      Mutation score  Survived  No coverage
src/cart.ts       71% (10 of 14)         4            0
src/checkout.ts     60% (3 of 5)         2            0
src/inventory.ts    63% (5 of 8)         2            0
All source        67% (18 of 27)         8            0

Test files                    Quality  Duplicates  Checks nothing  Live services
test/cart.test.ts        43% (3 of 7)           4               0              1
test/checkout.test.ts   100% (1 of 1)           0               0              0
test/inventory.test.ts   75% (3 of 4)           0               1              0
All tests               58% (7 of 12)           4               1              1

src/cart.ts
  ID        Line  Problem   Confidence  Test or method  Note
  0399f832    12  survived         87%  applyDiscount   With `101` instead of `100`, none of the …
  1be27338    12  survived         87%  applyDiscount   With `>` instead of `>=`, none of the 5 t…
  20fb814a    12  survived         87%  applyDiscount   With `1` instead of `0`, none of the 5 te…
  883b4b21    12  survived         84%  applyDiscount   With `false` as the condition, none of th…

test/cart.test.ts
  ID        Line  Problem    Confidence  Test or method        Note
  d0eacd17    10  redundant         94%  applyDiscount > tak…  Kills the same mutants as applyDis…
  7ff46fdf    14  redundant         94%  applyDiscount > tak…  Kills the same mutants as applyDis…
  3055e1ad    18  redundant         94%  applyDiscount > tak…  Kills the same mutants as applyDis…
  427fce7a    22  redundant         94%  applyDiscount > tak…  Kills the same mutants as applyDis…
  472ae559    32  infra             88%  subtotal > matches …  Calls a live service with nothing …

test/inventory.test.ts
  ID        Line  Problem  Confidence  Test or method         Note
  98a1a024    23  mocked            -  canFulfil > returns …  Mocks every method it calls: canFul…
shop at commit 0ade512: 4 methods, 12 tests, 14 problems, 10 shown, --all for the rest
Report: .perch/coverage/index.html
28 requests  0 tokens in  $0.0000
```

The mutation score is the share of mutants killed by at least one test. A test
kills a mutant when Perch puts its chance of failing against it at 70% or more.
No coverage is the number of mutants in methods no test reaches through the call
graph; they count against the score. Perch lists each survived mutant with the
edit it made and the number of tests that miss it. The confidence is how sure Perch is that no test kills the
mutant and that the mutant changes what a caller sees. A test that checks
nothing kills no mutant in the code it reaches. A duplicate kills exactly the
mutants an earlier test kills. A test that mocks what it tests calls only
methods it has replaced with its own mocks, so it checks the mocks; that is a
fact of the call graph and is listed with `-` for confidence, as is a problem on
a test or method the model couldn't be asked about. Use `--all` to see every
row.

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
prediction. Run for real on 149 mutants of Perch's own code, the tests killed
38; Perch called 41 killed, 30 of them right, and 100 of the 108 it called
survived had survived.

Perch only looks at the code your test frameworks run. It loads the same config
files as Vitest, Jest, pytest and coverage.py, which lets it ignore scripts,
examples and docs tooling that no test covers. On a branch, Perch only lists
problems in changed code.

## What gets mutated

Perch makes every mutant a method has; there is no cap. Each is one edit:

| Kind | Edit |
| --- | --- |
| `removal` | A statement that only calls something is removed: `save(order);` is gone. |
| `block` | An `if` body is emptied. |
| `condition` | A condition is replaced by `true`, and by `false`; a loop's only by `false`. |
| `boundary` | A comparison moves to its boundary or flips: `<` to `<=`, `==` to `!=`. |
| `logic` | `&&` and `\|\|` swap, `and` and `or` in Python and Lua. |
| `arithmetic` | `+`, `-`, `*`, `/` and `%` swap. |
| `update` | `+=` and `-=` swap, `n++` becomes `n--`. |
| `not` | A `!` or `not` is dropped. |
| `negative` | A leading minus is dropped. |
| `boolean` | `true` becomes `false` and back. |
| `string` | A string literal is emptied. Names are left alone: what is imported, an object's key, a docstring. |
| `number` | An integer moves by one; `0` becomes `1` and `1` becomes `0`. |
| `return` | A returned number is zeroed, a string emptied, a list or object emptied, and in JavaScript, Python, Ruby, PHP and Lua any other value becomes the language's null. |

A method with none of these, a one-line delegate or a getter, gets no
mutants and counts as covered with nothing to kill. A method no test reaches
gets its mutants too, but perch asks nothing about them: they have no coverage,
they count against the score, and none is listed as a problem, because whether
the method needs a test is not something the call graph can say.

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

Every language perch finds tests in, the frameworks it recognises, the mocks it
reads as cutting a test's reach, and what it does not follow yet:

| Language | Test frameworks | Mocks | Not followed yet |
| --- | --- | --- | --- |
| Python | pytest, unittest | `unittest.mock.patch`, `monkeypatch` | |
| JavaScript, TypeScript, TSX | Vitest, Jest, Mocha, node:test | `vi.mock`, `jest.mock`, spies | |
| Go | testing (subtests, table tests), testify suites | | calls through struct fields and `range` variables |
| Rust | libtest, nextest | mockall `MockX::new()` | |
| Java, Kotlin | JUnit 5, JUnit 4, TestNG | Mockito, MockK | |
| Scala | ScalaTest (FunSuite, FlatSpec, FunSpec, WordSpec, FeatureSpec), munit, specs2 `in`/`>>` | | `new X()` as a call; a case class's `apply`; `s2"""` specs |
| C# | xUnit, NUnit, MSTest | | property reads; records and structs with a primary constructor |
| Swift | XCTest, Swift Testing | | computed property reads; a `@Suite` `init` as setup |
| C | Check, cmocka, Criterion, Unity | | Criterion `Theory` and struct-typed parameters; Unity runners generated elsewhere |
| C++ | GoogleTest, Catch2 v3, doctest | gmock classes | |
| Ruby | Minitest, RSpec, test-unit | `allow`/`expect(...).to receive`, doubles, Minitest `stub` | a bare `helper` with no arguments or parentheses; `.rspec --require` |
| PHP | PHPUnit (`test*`, `#[Test]`, `@test`, data providers), Pest | `createMock`, Mockery, Pest `mock` | `parent::m()`; `use` of a namespace prefix |
| Lua | busted, luaunit | `stub`, `spy.on` | `return { f = f }` exports; luaunit without a visible `require("luaunit")` |
| Zig | `test` blocks, decltests | | `for (items) \|x\|` payload captures |
| Solidity | Foundry test contracts (`test*`, `testFuzz_*`, `invariant*`) | | `setUp` inherited from a base test contract |

Groovy and Bash parse, but their grammars give perch nothing to hang a test on:
the Groovy grammar has no function node at all, and a bats `@test` block has no
node that spans its body. A test in a framework perch doesn't recognize isn't
found.

## Checking a branch

Run perch with `--since REF` to list the problems in methods and tests you've
changed on the branch:

```console
$ perch coverage --since main
src/cart.ts
  ID        Line  Problem   Confidence  Test or method  Note
  20fb814a    12  survived         86%  applyDiscount   With `1` instead of `0`, none of the 5 te…
  1be27338    12  survived         85%  applyDiscount   With `>` instead of `>=`, none of the 5 t…
  0399f832    12  survived         84%  applyDiscount   With `101` instead of `100`, none of the …
  883b4b21    12  survived         81%  applyDiscount   With `false` as the condition, none of th…

test/cart.test.ts
  ID        Line  Problem    Confidence  Test or method        Note
  427fce7a    22  redundant         76%  applyDiscount > tak…  Kills the same mutants as applyDis…
shop at commit 6fe98ce: 4 methods, 12 tests, 5 problems in changed code, 9 elsewhere
Report: .perch/coverage/index.html
28 requests  0 tokens in  $0.0000
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
