# Code style

How perch's own code and tests are written. The rules in perch.yaml are shown
this file and judge one section each.

## Errors

A catch block or a .catch() callback rethrows the error, returns it to the
caller, or reports it. An empty catch is wrong. So is one that returns a stand-in
value such as null, [] or '' so the method carries on as if the step had worked.
A catch that turns only a missing file (ENOENT) into an empty value, and
rethrows every other error, is fine.

## Tests

A test calls code imported from src/, or runs the perch command, and asserts on
what that code returned, printed, wrote or sent. A test whose assertions would
still pass if the code under test did nothing is wrong: it checks a value the
test built itself, or a fake's canned reply that never went through code from
src/. Asserting on what a fake recorded the code sending it is fine.
