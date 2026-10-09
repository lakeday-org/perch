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
Source files       Mutation score  Survived  No coverage
shop/checkout.py      0% (0 of 9)         8            1
shop/inventory.py    57% (4 of 7)         3            0
shop/cart.py       58% (18 of 31)         6            7
All source         47% (22 of 47)        17            8

Test files                     Quality  Duplicates  Checks nothing  Live services
tests/test_cart.py        71% (5 of 7)           2               0              1
tests/test_inventory.py   33% (1 of 3)           0               2              0
All tests                64% (7 of 11)           2               2              1
1 test file has nothing to fix.

Where to add tests
  Method          Where                  Killed  Survived  Tests
  place_order     shop/checkout.py:4     0 of 9         8      1
    Add a test that asserts on the result of line 5, where `not inventory.can_fulfil(stock, item,
    1)` can become `inventory.can_fulfil(stock, item, 1)` unnoticed. 7 more edits survive.
  subtotal        shop/cart.py:13       7 of 11         4      4
    Add a test that asserts on the value `0` at line 16. 3 more edits survive.
  reserve         shop/inventory.py:5    0 of 3         3      2
    Add a test that fails when the method does nothing. 2 more edits survive.
  apply_discount  shop/cart.py:5       11 of 17         2      4
    Add a test in which the condition at line 8 is true, and assert on what follows. 1 more edit
    survives.

tests/test_cart.py
  ID        Line  Problem    Confidence  Test or method       Note
  a887c457    10  redundant        100%  test_save10_again    Kills the same mutants as test_save…
  e5e97cb7    22  redundant        100%  test_subtotal_again  Kills the same mutants as test_subt…
  52197ed7    31  infra             94%  test_rate            Calls a live service with nothing m…

tests/test_inventory.py
  ID        Line  Problem         Confidence  Test or method      Note
  d3074257     7  mocked                   -  test_can_fulfil_m…  Mocks every method it calls: ca…
  43c90ed6    16  checks_nothing        100%  test_reserve_runs   Kills none of the 3 mutants in …
shop at commit c8ea0ed: 6 methods, 11 tests, 22 problems, --all for every mutant
Report: .perch/coverage/index.html
18 requests  0 tokens in  $0.0000
```

The mutation score is the share of mutants killed by at least one test, leaving
out equivalent mutants, which no test could kill. A test kills a mutant when it
fails with the mutant in place. No coverage counts the mutants on lines no test
runs. They count against the score. Source files are listed worst first, and
test files only when something in them needs fixing.

Under the tables, Perch lists the methods to add a test to, most survived
mutants first. Each has a line of numbers and, under it, the test to add, from
its surest survived mutant: the edit a new test has to tell apart, and the line
it is on. `--all` lists every method, and every survived mutant with the id
that `perch close` takes. Test problems follow, by file. A survivor's confidence
is how sure the model is that a caller could see the edit. A test problem the
test run settled is 100%. A test that checks nothing kills no mutant in the code
it reaches. A duplicate kills exactly the mutants an earlier test kills. A test
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

Perch runs your tests itself, in a copy of the repository at the commit, so
your working tree is never touched:

1. It runs the suite once and records which tests reach each mutant. A mutant
   no test reaches has no coverage.
2. It runs each mutant against only the tests that reach it, and stops at the
   first test that fails, as Stryker does. A run that takes half as long again
   as it should, plus five seconds, catches the mutant too: the mutant made
   something never finish. So does a run the mutant crashes before its tests
   report. A mutant the code can't even be built or loaded with is invalid,
   and is left out.
3. It asks the decision model about the survivors only: would a caller ever see
   this change, or is it harmless, like a log message, or an edit that changes
   nothing? Harmless survivors are equivalent mutants, and are left out of the
   score. Stryker and PIT can't tell them apart from real gaps.

The tests that kill nothing they run, and the tests that kill exactly what
another test kills, come from the same real results. A test that killed nothing
is run alone against the rest of its mutants before perch says so. Tests in one
file that reach exactly the same mutants are run against all of them before
perch calls one a duplicate.

Nothing is set up again for each mutant. Each test run is sandboxed once, for
the whole run, so a mutated test can write only inside its copy:

- **pytest:** pytest collects your suite once. Each mutant runs in a process
  forked from it, with the mutated function swapped in.
- **Vitest, Jest, Mocha, Jasmine and node:test:** perch writes every mutant
  into the code at once, each behind a switch, as Stryker does. Vitest, Jest
  and Mocha stay loaded in a worker per core, and each mutant is one run inside
  it with its switch on. Jasmine and node:test start for each mutant, with the
  code already transformed.
- **Rust and C#:** the same switches, built once by cargo or dotnet. A mutant
  the compiler rejects, a value a constant needs at compile time, is taken out
  and the code built again; it counts as invalid, as Stryker.NET counts it.
- **Java, Kotlin and Scala:** the same switches, built once by Gradle, Maven or
  sbt, and run as PIT runs them: in a JVM per core kept warm, through JUnit 5,
  JUnit 4, TestNG, ScalaTest or MUnit. The project's own classes load afresh
  for each mutant, so state one run leaves behind is not the next one's.
- **Go:** Go has no expression that chooses between two values of any type, so
  each mutant is written into its own copy of the module and its package built
  again, which Go's build cache makes quick.

Perch saves each mutant's outcome. A later run reuses it while the mutant's
code, the tests that reach it, every file those tests run, and your dependency
manifests are unchanged.

Perch runs pytest with the Python on your `PATH`, so activate the project's
environment first. It needs `pytest-cov` installed there. For JavaScript and
TypeScript it runs the framework installed in your `node_modules`, so install
your dependencies first. node:test needs Node 22 or later. Rust needs cargo, Go
needs go, and C# needs dotnet and a test project that references
`Microsoft.NET.Test.Sdk`. Java, Kotlin and Scala need a JDK and the project's
Gradle, Maven or sbt. If perch can't run
your tests, it stops and says what's missing. In a repository that also has
tests in a language perch has no runner for, perch leaves out the code only
those tests run, and says so.

Perch only looks at the code your test frameworks run. It reads the same config
files as Vitest, Jest, pytest and coverage.py, which lets it ignore scripts,
examples and docs tooling that no test covers.

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
gets its mutants too, but perch runs and asks nothing about them: they have no
coverage, they count against the score, and the No coverage column counts them
rather than listing each one.

## What it reads

`perch coverage` reads the code your test frameworks run and measure. It
ignores release scripts, examples, documentation tooling and CI actions.

- **Vitest and Jest:** perch loads your configuration using the copy of the
  framework you've installed, so it runs over the same tests the framework
  would run. The coverage configuration's `include` and `exclude` options decide
  which files are source code. If you don't have an `include` option, the
  source is the code your tests import, plus the files beside your tests.
- **Mocha, Jasmine and node:test:** perch reads every test it finds, and the
  code beside it. node:test keeps the flags your `test` script passes to
  `node`, such as `--experimental-test-module-mocks`.
- **pytest:** perch reads the `testpaths` and `python_files` options from
  `pytest.ini`, `pyproject.toml`, `tox.ini` or `setup.cfg`, and the `source`
  and `omit` options from your coverage.py configuration.
- **Go, Rust and C#:** perch covers the module the tests are in: the Go module,
  the code under a Rust crate's `src/`, and the projects a .NET test project
  references, directly or through each other.

Perch tells you which frameworks it decided on when you run it with
`--verbose`:

```
$ perch coverage --verbose
...
[perch] pytest (pytest.ini) runs 3 test files
```

If perch can't load a configuration, it names that configuration on the last
line and reads every test it can find instead. `--verbose` shows the error. You
can leave out more files and directories with the `ignore:` option in
`perch.yaml`.

## Supported languages and frameworks

Perch runs pytest, Vitest, Jest, Mocha, Jasmine, node:test, cargo test, go test
and dotnet test suites, with xUnit, NUnit or MSTest, and JUnit 5, JUnit 4,
TestNG, ScalaTest and MUnit suites on Gradle, Maven or sbt. The table below is every language perch finds tests in, the frameworks it
recognises, the mocks it reads as cutting a test's reach, and what it does not
follow yet:

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
  Method          Where             Killed  Survived  Tests
  apply_discount  shop/cart.py:5  17 of 26         5      6
    Add a test in which the condition at line 8 is true, and assert on what follows. 4 more edits
    survive.

tests/test_cart.py
  ID        Line  Problem    Confidence  Test or method   Note
  cebd9d70    18  redundant        100%  test_free_small  Kills the same mutants as test_free at …
shop at commit ac68c9e: 6 methods, 13 tests, 6 problems in changed code, 3 elsewhere, --all for every mutant, 26 mutants outside the change not run
Report: .perch/coverage/index.html
6 requests  0 tokens in  $0.0000
```

On a branch, perch runs only the mutants in code the branch changed, and the
ones its changed tests reach. Every other mutant keeps the outcome saved by an
earlier run, when it still holds; one with no saved outcome isn't run, and the
last line counts it. A test that reaches a mutant that wasn't run isn't called
a duplicate or said to check nothing.

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
