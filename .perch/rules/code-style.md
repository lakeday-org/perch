# Code style

## Errors

- A catch rethrows the error, returns it to the caller, or reports it.
- A catch never returns a stand-in such as null, [] or '' and carries on as if the step worked.
- A catch may turn a missing file (ENOENT) into an empty value when it rethrows every other error.

## Tests

- A test calls code from src/ or runs the perch command.
- A test asserts on what that code returned, printed, wrote or sent.
- A test never asserts only on a value it built itself, or on a fake's canned reply.
- A test may assert on what a fake recorded the code sending it.
