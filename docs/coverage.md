---
title: Test coverage
nav: Test coverage
group: Using perch
order: 5.5
summary: Find unit tests of low value and discover the real coverage gaps in your code.
---

# Test coverage

Perch Coverage finds low-value unit tests and the real gaps in your test
coverage. It is mutation testing with a decision model on top. Perch plants
small bugs, mutants, in your code and runs your tests against each one. A
mutant no test catches is a survivor. Most survivors are noise, so perch asks a
decision model, Jev, which of them a user could ever notice. It lists only
those, each with the test to write.

A mutant is one edit to one method. Perch removes a call statement, empties an
`if` body, forces a condition to `true` or `false`, or swaps an operator: `<`
to `<=`, `&&` to `||`, `+` to `-`, `n++` to `n--`. It swaps a method for its
opposite, `startsWith` for `endsWith`, or drops `.filter(…)` from a chain. It
drops a `!`, flips a boolean, empties a string or a list, moves a number by
one, makes `a?.b` unconditional, or replaces a returned value. These are the
operators Stryker and PIT use. If a test fails with a mutant in place, the test
kills it. If every test passes, the mutant survives. A survived mutant is a
real gap in your coverage: a test runs that code, and nothing checks what it
does.

Point it at a repository:

```console
$ perch coverage
Source files      Mutation score  Survived  No coverage
src/checkout.ts     60% (3 of 5)         2            0
src/inventory.ts    67% (6 of 9)         2            0
src/cart.ts       71% (10 of 14)         4            0
All source        68% (19 of 28)         8            0

Test files                    Quality  Duplicates  Checks nothing  Live services
test/cart.test.ts        43% (3 of 7)           4               0              1
test/inventory.test.ts   75% (3 of 4)           0               1              0
All tests               58% (7 of 12)           4               1              1
1 test file has nothing to fix.

Where to add tests
  Method         Where                Killed  Survived  Tests
  applyDiscount  src/cart.ts:11      6 of 10         4      5
    Add a test that asserts on the value `100` at line 12. 3 more edits survive.
  placeOrder     src/checkout.ts:5    3 of 5         2      1
    Add a test in which the condition at line 6 is true, and assert on what follows. 1 more edit
    survives.
  canFulfil      src/inventory.ts:4   6 of 9         2      4
    Add a test that asserts on the value `0` at line 6. 1 more edit survives.

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
shop at commit 0ade512: 4 methods, 12 tests, 14 problems, --all for every mutant
Report: .perch/coverage/index.html
29 requests  2k tokens in / 93 out  $0.0005
```

The mutation score is the share of mutants killed by at least one test, leaving
out equivalent mutants, which no test could kill. A test kills a mutant when it
fails with the mutant in place. Where perch can't run the tests, it's when the
model puts that chance at 70% or more. No coverage counts the mutants on lines
no test runs. They count against the score. Source files are listed worst first, and
test files only when something in them needs fixing.

Under the tables, Perch lists the methods to add a test to, most survived
mutants first. Each has a line of numbers and, under it, the test to add, from
its surest survived mutant: the edit a new test has to tell apart, and the line
it is on. `--all` lists every method, and every survived mutant with the id
that `perch close` takes. Test problems follow, by file. The confidence is how
sure Perch is. A test that checks nothing kills no mutant in the code it
reaches. A duplicate kills exactly the mutants an earlier test kills. A test
that mocks what it tests calls only methods it has replaced with its own mocks,
so it checks the mocks. That is a fact of the call graph, so it is listed with
`-` for confidence. So is a problem on a test or method the model couldn't be
asked about.

Perch also writes an HTML report. It opens on the methods to add a test to,
each with its score, how many tests reach it, and the test to add; the mutants
fold out under the row. Source files are a tree of directories, worst first,
with each score coloured against 60% and 80% as Stryker colours its own. A
file's page shows its code with a mark in the gutter on each line where a
mutant survived; press the mark to see each edit, the line both ways, and a
Copy prompt button, or step through the survivors with the Next survived
button. The report is one file, unless your repository has more than 8 MB of
source. Then each file gets its own page in the `files/` directory next to
`index.html`.

## How it works

A coverage report tells you which lines your tests ran. A line that ran is not a
line that was checked: a test can call a method, assert nothing about the
result, and still turn every line it touched green. Mutation testing asks the
question coverage can't: if this line were wrong, would any test notice?

Perch runs your tests itself, in copies of the repository at the commit, so
your working tree is never touched:

1. It runs the suite once with per-test coverage, to learn exactly which tests
   run each line. A mutant on a line no test runs has no coverage.
2. It plants each mutant and runs only the tests that run its line. A test
   that fails catches it. A run that takes three times as long as it should
   catches it too: the mutant made something never finish. A mutant the tests
   can't even load against broke the code, and is left out.
3. It asks the decision model about the survivors only: would a caller ever see
   this change, or is it harmless, like a log message, or an edit that changes
   nothing? Harmless survivors are equivalent mutants, and are left out of the
   score. Stryker and PIT can't tell them apart from real gaps.

The tests that kill nothing they run, and the tests that kill exactly what
another test kills, come from the same real results.

Perch runs pytest today, with the Python on your `PATH`, so activate the
project's environment first. It needs `pytest-cov` installed there. For any
other framework, perch estimates which tests run each method from the call
graph and predicts what they catch, and the report says it's an estimate.

Perch only looks at the code your test frameworks run. It loads the same config
files as Vitest, Jest, pytest and coverage.py, which lets it ignore scripts,
examples and docs tooling that no test covers. On a branch, Perch only lists
problems in changed code.

## What gets mutated

Perch makes every mutant a method has; there is no cap. Each is one edit:

| Kind | Edit |
| --- | --- |
| `body` | The whole body is emptied, or returns its type's zero: does any test notice when the method does nothing? |
| `removal` | A statement that only calls something is removed: `save(order);` is gone. |
| `method` | A method becomes its opposite, or its call drops out of the chain: `startsWith` to `endsWith`, `toUpperCase` to `toLowerCase`, `min` to `max`, `every` to `some`; `.trim()`, `.filter(…)`, `.sort()`, `.slice(…)` gone. Each language's own names: `strip`, `upcase`, `hasPrefix`, `strings.TrimSpace`, `std::min`. |
| `block` | An `if` body is emptied. |
| `condition` | A condition is replaced by `true`, and by `false`, in an `if`, a `?:`; a loop's only by `false`. |
| `boundary` | A comparison moves to its boundary or flips: `<` to `<=`, `==` to `!=`. |
| `logic` | `&&` and `\|\|` swap, `and` and `or` in Python and Lua, `??` becomes `&&`. |
| `arithmetic` | `+`, `-`, `*`, `/` and `%` swap. |
| `update` | `+=` and `-=` swap, `*=` and `/=`, `<<=` and `>>=`, `&=` and `\|=`, `&&=` and `\|\|=`; `??=` becomes `&&=`; `n++` becomes `n--`. |
| `chaining` | An optional chain is made unconditional: `a?.b` becomes `a.b`, `a&.b` becomes `a.b` in Ruby, `a?.b` becomes `a!!.b` in Kotlin. |
| `lambda` | An arrow function's expression body returns `undefined`. |
| `not` | A `!` or `not` is dropped. |
| `negative` | A leading minus is dropped. |
| `boolean` | `true` becomes `false` and back. |
| `collection` | A list, dictionary or object literal is emptied: `[1, 2]` to `[]`, `{ a: 1 }` to `{}`, `vec![1, 2]` to `vec![]`. An empty list is filled: `[]` to `["perch was here"]`. |
| `string` | A string literal is emptied, and an empty one is filled: `""` to `"perch was here"`. Names are left alone: what is imported, an object's key, a docstring. |
| `number` | An integer moves by one; `0` becomes `1` and `1` becomes `0`. |
| `regex` | A regular expression loses an anchor, a `+` becomes `*` and back, a `?` goes, `\d` becomes `\D`, `[^a]` becomes `[a]`. |
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
Where to add tests
  Method         Where            Killed  Survived  Tests
  applyDiscount  src/cart.ts:11  6 of 10         4      5
    Add a test that asserts on what line 12 returns. 3 more edits survive.

test/cart.test.ts
  ID        Line  Problem    Confidence  Test or method        Note
  427fce7a    22  redundant         76%  applyDiscount > tak…  Kills the same mutants as applyDis…
shop at commit 6fe98ce: 4 methods, 12 tests, 5 problems in changed code, 9 elsewhere, --all for every mutant
Report: .perch/coverage/index.html
29 requests  0 tokens in  $0.0000
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
