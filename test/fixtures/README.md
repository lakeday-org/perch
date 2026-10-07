# Scanner example applications

These applications deliberately accept an order when one requested item is in
stock and another is unavailable. The Python application also contains the
other defects used in the public documentation. Keep the fixture defects in
source; apply corrections only to temporary copies.

| Application | Language | Availability check |
| --- | --- | --- |
| `order-service` | Python | `checkout.py::can_fulfil` |
| `order-service-unittest` | Python | `checkout.py::can_fulfil` |
| `order-service-typescript` | TypeScript | `src/inventory.ts::canFulfil` |
| `order-service-frontend` | TypeScript + React TSX | `src/CheckoutPanel.tsx::canCheckout` |
| `order-service-jest` | TypeScript | `src/inventory.ts::canFulfil` |
| `order-service-mocha` | TypeScript | `src/inventory.ts::canFulfil` |
| `order-service-node-test` | TypeScript | `src/inventory.ts::canFulfil` |
| `order-service-frontend-jest` | TypeScript + React TSX | `src/CheckoutPanel.tsx::canCheckout` |
| `order-service-rust` | Rust | `src/inventory.rs::can_fulfil` |
| `order-service-java` | Java 17+ | `src/example/Inventory.java::Inventory.canFulfil` |
| `order-service-java-junit4` | Java 17+ | `src/example/Inventory.java::Inventory.canFulfil` |
| `order-service-java-testng` | Java 17+ | `src/example/Inventory.java::Inventory.canFulfil` |
| `order-service-cpp` | C++17 | `src/checkout.cpp::can_fulfil` |
| `order-service-cpp-catch2` | C++17 | `src/checkout.cpp::can_fulfil` |
| `order-service-cpp-doctest` | C++17 | `src/checkout.cpp::can_fulfil` |

`npm test` parses every application here and checks the buggy methods' names,
source spans and complexity. Each application must have zero parse failures.
The repository's `perch.yaml` excludes `test/fixtures/**` from ordinary scans.
The TypeScript apps have their own compiler settings and dependencies.

## Unit tests

Each application has the same twelve tests in its own framework, for
`perch coverage` to read. perch parses them and never runs them. Each app's `expected.json` holds what
each test is expected to reach, what its mock cuts, what outside systems it
touches, and how it should be labelled.

| Application | Framework | Test files |
| --- | --- | --- |
| `order-service` | pytest | `tests/test_order_service.py` |
| `order-service-unittest` | unittest | `tests/test_order_service.py` |
| `order-service-typescript` | Vitest | `test/*.test.ts` |
| `order-service-frontend` | Vitest | `src/*.test.tsx` |
| `order-service-jest` | Jest with ts-jest | `test/*.test.ts` |
| `order-service-mocha` | Mocha with ts-node and Sinon | `test/*.test.ts` |
| `order-service-node-test` | node:test, run on the TypeScript as Node strips its types | `test/*.test.ts` |
| `order-service-frontend-jest` | Jest with ts-jest | `src/*.test.tsx` |
| `order-service-rust` | `#[test]` | `src/tests.rs` |
| `order-service-java` | JUnit 5 and Mockito | `test/example/*Test.java` |
| `order-service-java-junit4` | JUnit 4 and Mockito | `test/example/*Test.java` |
| `order-service-java-testng` | TestNG and Mockito, with `@Test` on the class in `CartTest` | `test/example/*Test.java` |
| `order-service-cpp` | GoogleTest | `test/*_test.cpp` |
| `order-service-cpp-catch2` | Catch2 v3 | `test/*_test.cpp` |
| `order-service-cpp-doctest` | doctest | `test/*_test.cpp` |

| Test | What it does |
| --- | --- |
| 1 | Checks availability with every item in stock and expects true. |
| 2 | Checks availability of an empty cart and expects false. |
| 3 | Checks availability when a quantity equals the stock level and expects true. |
| 4 to 8 | Apply a 10, 20, 25, 50 and 75 percent discount. They check the same behavior, and none reaches the branch for 100 percent or more. |
| 9 | Stubs the availability check and asserts the value the stub returns. |
| 10 | Calls subtotal and asserts nothing. |
| 11 | Reads a credential from the environment, opens a database or a socket, and checks subtotal against what it read. |
| 12 | Places an order with nothing mocked, so the test reaches code in files it never calls directly. |

No test puts an unavailable item after an available one, so the availability
defect stays untested.

## Test reports

Each application's `reports/` holds what its CI writes when it runs those
tests under coverage, for `perch coverage` to read. The tests really ran, in a
temporary copy, and the failing ones failed: no database, no price service, no
credentials. The only change after a tool wrote a file is the temporary copy's
path made relative to the application root.

| Application | Files |
| --- | --- |
| `order-service` | `junit.xml` (pytest), `lcov.info` and `coverage.json` with per-test contexts (coverage.py) |
| `order-service-unittest` | `reports/unittest/`: `junit.xml` (unittest-xml-reporting), `lcov.info` and `coverage.json` with a context per test method (coverage.py, `dynamic_context = "test_function"` in its `pyproject.toml`) |
| `order-service-typescript` | `reports/vitest/`: `junit.xml`, `lcov.info`, `cobertura.xml` (Vitest, v8) |
| `order-service-frontend` | `reports/vitest/`: `junit.xml`, `lcov.info`, `cobertura.xml` (Vitest, v8) |
| `order-service-jest` | `reports/jest/`: `junit.xml` (jest-junit, configured in its `package.json` to write each test's file and to join describe titles with ` > `), `lcov.info`, `cobertura.xml` (Jest's Istanbul coverage) |
| `order-service-frontend-jest` | `reports/jest/`: the same as `order-service-jest` |
| `order-service-mocha` | `reports/mocha/`: `junit.xml` (mocha-junit-reporter, configured in its `.mocharc.json` with `jenkinsMode` and ` > ` between suite titles), `lcov.info`, `cobertura.xml` (c8) |
| `order-service-node-test` | `reports/node-test/`: `junit.xml` and `lcov.info` (Node's own junit and lcov reporters and its test coverage). The stub test mocks a module, and Node writes a second `src/inventory.ts` record for the mock. |
| `order-service-rust` | `reports/libtest/`: `junit.xml` (libtest), `lcov.info` with one `TN` record per test (cargo-llvm-cov) |
| `order-service-rust` | `reports/nextest/`: `junit.xml` (cargo-nextest, from the `ci` profile in the app's `.config/nextest.toml`), `lcov.info` for the whole run (`cargo llvm-cov nextest`) |
| `order-service-java` | `reports/maven/`: `junit/TEST-*.xml` (Maven Surefire), `jacoco.xml` (JaCoCo) |
| `order-service-java` | `reports/gradle/`: `junit/TEST-*.xml` (Gradle), `jacoco.xml` (Gradle's JaCoCo plugin), from the same tests |
| `order-service-java-junit4` | `reports/maven/`: `junit/TEST-*.xml` (Maven Surefire), `jacoco.xml` (JaCoCo) |
| `order-service-java-testng` | `reports/maven/`: `junit/TEST-TestSuite.xml`, one file for every class as Surefire writes TestNG's run, and `jacoco.xml` (JaCoCo) |
| `order-service-cpp` | `reports/googletest/`: `junit.xml` (GoogleTest), `cobertura.xml` (gcovr from the run's gcov data) |
| `order-service-cpp-catch2` | `reports/catch2/`: `junit.xml` (Catch2's JUnit reporter, run with `--warn NoAssertions` so the test that asserts nothing is written), `cobertura.xml` (gcovr) |
| `order-service-cpp-doctest` | `reports/doctest/`: `junit.xml` (doctest's JUnit reporter), `cobertura.xml` (gcovr) |

Regenerate them from the repository root:

```sh
node scripts/fixture-reports.mjs
```

It needs a Python with pytest, pytest-cov, coverage and unittest-xml-reporting (`PERCH_FIXTURE_PYTHON`),
npm, a nightly Rust with cargo-llvm-cov and cargo-nextest (`PERCH_FIXTURE_RUST_TOOLCHAIN`),
and a JDK (`PERCH_FIXTURE_JAVA_HOME`) with Maven and Gradle.
It skips any application whose tools are missing, says what was missing, and
leaves that application's `reports/` as it was. The script's header says how
each file is produced.

## Live CLI verification

With `PERCH_API_KEY` exported, run this from the repository root:

```sh
npm run test:fixtures
```

This makes real Jev requests. It creates six temporary git repositories and
checks scanning, cached rescans, method and issue-id checks, verbose diagnostics,
path and revision filters, issue inspection, close/reopen, rule add/edit/remove,
whole-file rules, doctor and Codex setup. It corrects the stock check without a
commit and requires both the method rule and the file rule to pass. It then
commits that correction and checks the changed-file scan.

The report and command output are saved under `.perch/fixture-verification/`.
The report names the temporary repositories so failures can be inspected.
The fixture source files are never changed by this command.

## Run an application

Run these commands inside the selected application's directory:

| Application | Commands |
| --- | --- |
| Python | `python3 main.py` |
| TypeScript | `npm install`, `npm run build`, `npm start` |
| React frontend | `npm install`, `npm run build`, `python3 -m http.server 8000` |
| Rust | `cargo run` |
| Java | `javac --release 17 -d out src/example/*.java`, `java -cp out example.Main` |
| C++ | `mkdir -p out`, `c++ -std=c++17 src/*.cpp -o out/orders`, `./out/orders` |

The frontend opens at `http://localhost:8000`. Its Place order button is enabled
despite the unavailable pens. The console applications likewise accept the
mixed-stock order. These outcomes are the defects the checks must identify.

## Code outside a named function

`unnamed-code` holds source that no named function contains. It has a callback
passed to a wrapper, a function assigned to an export, and a callback handed to
a call. It also has a module that exports a value, functions a macro generates,
and a Python entry point. `example/Inventory.java` has nothing outside its
methods but the class around them. `npm test` checks which units a scan reads
from each file.
