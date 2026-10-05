# Project fixtures

Small projects laid out and tested the way real ones are, one per supported test framework. Where the order-service apps
translate the same twelve tests into each framework, these are written in each ecosystem's own idiom, so perch meets the
patterns real repositories use: a `src/` layout, barrel files and re-exports, default and CommonJS exports, crates that call
each other by name, constructors, setup in a suite, helpers in test files, table-driven and parametrized tests, mocks, a test
config that decides what is in scope, and code no test reaches.

Each project's `reports/` holds what its real test run wrote: JUnit XML and the coverage report. `regenerate.sh` in the project
reruns the tools and rewrites them; it is the only thing that writes them.

`test/project-fixtures.test.js` reads every project, its reports, and its `expected.json`, which is written by reading the
project, not by running perch:

| Key | What it says |
| --- | --- |
| `language`, `framework` | What the project is. |
| `reports` | `{ kind: [paths] }`, kinds as `perch coverage` takes them: `junit`, `lcov`, `cobertura`, `jacoco`, `contexts`. |
| `left_out` | Files no test framework covers, which `perch coverage` must leave out: scripts, examples, docs tooling. |
| `tests` | Each test as `{ file, name, status, reaches }`: `name` as perch names it, `status` the run's in the JUnit report, `reaches` methods the test must reach, as `path::qualified_name`. |
| `untested` | Every method the coverage report shows never ran, as `path::qualified_name`. |
