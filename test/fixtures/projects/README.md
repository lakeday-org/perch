# Project fixtures

Small projects laid out and tested the way real ones are, one per supported test framework. Where the order-service apps
translate the same twelve tests into each framework, these are written in each ecosystem's own idiom, so perch meets the
patterns real repositories use: a `src/` layout, barrel files and re-exports, default and CommonJS exports, crates that call
each other by name, constructors, setup in a suite, helpers in test files, table-driven and parametrized tests, mocks, a test
config that decides what is in scope, and code no test reaches.

`test/project-fixtures.test.js` reads every project and its `expected.json`, which is written by reading the project, not by
running perch:

| Key | What it says |
| --- | --- |
| `language`, `framework` | What the project is. |
| `left_out` | Files no test framework covers, which `perch coverage` must leave out: scripts, examples, docs tooling. |
| `tests` | Each test as `{ file, name, reaches }`: `name` as perch names it, `reaches` methods the test must reach, as `path::qualified_name`. |
