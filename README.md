<p align="center">
  <a href="https://perchscan.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/logo.svg">
      <img alt="perch" src=".github/logo-light.svg" width="300">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@lakeday/perch"><img alt="npm" src="https://img.shields.io/npm/v/@lakeday/perch"></a>
  <a href="https://github.com/lakeday-org/perch/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/lakeday-org/perch/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://nodejs.org"><img alt="node" src="https://img.shields.io/node/v/@lakeday/perch"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@lakeday/perch"></a>
</p>

<p align="center">
  <a href="https://perchscan.com">perchscan.com</a> &nbsp;&middot;&nbsp;
  <a href="https://docs.perchscan.com">docs</a>
</p>

perch finds bugs and design problems in a repo.

`perch scan` parses every tracked file with tree-sitter, scores each method, then
asks a TypeSafe System One model a fixed set of questions about each one: is
there a bug, where, what kind, how bad, is it a security hole, does it do what
its name says, does it need refactoring. Answers come back as probabilities.
Methods are sorted worst first.

Rules you write in `perch.yaml` are asked in the same reading, so they cost
nothing extra on a method perch was reading anyway. `perch check` asks any of it
about one method or file as it reads on disk, so you can change something and see
whether it still holds.

## Getting started

```sh
# 1. install
npm install -g @lakeday/perch

# 2. the key
export TYPESAFE_API_KEY=...

# 3. scan (later runs only re-read methods that changed)
perch scan

# 4. see what it found
perch issues

# 5. read one, by the id in the first column
perch issues 92c7781e

# 6. change it, then ask whether it still holds
perch check 92c7781e
```

Needs Node 22+ and git. Nothing perch does writes to your working tree.

## Your own rules

Rules you write in `perch.yaml` are questions perch asks beside its own. Two examples:

```yaml
- name: env-read-once
  where: "src/**/*.js"
  except: "src/cli.js"
  each: method
  ensure: >
    This method does not read process.env. Reading the environment is the command
    line's job, and everything below it is passed the values.

- name: tests-assert-real-behavior
  where: "test/**/*.test.js"
  each: test
  sees: calls
  ensure: >
    Tests assert on the code under test, not on mocks they set up or values they
    built.
```

The first asks a yes-or-no question about every method outside `src/cli.js`. It
rides in that method's own reading, because every question in a request is scored
against the code by itself and the code is what the request is mostly made of: a
method covered by five rules is one reading, not six.

The second asks about each test, and `sees: calls` puts the code that test calls in
front of the model, since the test alone cannot show whether what it asserts is
real. A method needs no `sees`, because it is always read with its callers and
callees in view.

`ensure` has to hold everywhere. `ensure_present` and `ensure_absent` are claims
about the codebase rather than any one file, so they search the likeliest units
first and stop at the answer.

Broken rules are listed with everything else, under type `lint`:

```
$ perch issues --filter type=lint
ID        Method       Location          Type  Kind           Severity
b4e21c7a  createModel  src/model.js:29   lint  env-read-once  -
9f03d182  git          src/git.js:10     lint  env-read-once  -
```

`perch scan` exits 1 when a rule is broken. A rule is a claim you made about your
own code, so CI can read that; a finding perch turned up on its own is a
probability, and exiting on one would make every run a coin toss.

`perch rules list`, `add`, `edit` and `remove` change `perch.yaml` without opening
it, keeping your comments and ordering.

The questions perch ships with are written in the same grammar, in `scan.yaml`, and
`perch.yaml` can reword one or add a class of its own.

## Commands

| Verb | What it does | Needs |
| --- | --- | --- |
| `scan` | Parses every tracked file at HEAD, then reads methods with System One, walking the call graph from the worst-scoring method through its callers and callees. Asks your rules in the same reading. Every run reads everything it covers; `--paths` and `--since` narrow what that is. Prints the table, and exits 1 if a rule is broken. | `TYPESAFE_API_KEY` |
| `issues` | The open issues, worst first. With an id, everything known about that one method. | nothing |
| `check` | Asks about one file or method as it reads on disk, uncommitted. `--rules` narrows it. Records nothing. | `TYPESAFE_API_KEY` |
| `rules` | `list`, `add`, `edit`, `remove`: changes `perch.yaml` without opening it. | nothing |
| `close` | Marks issues closed: false positives, or code you've looked at and aren't changing. They stop being listed. | nothing |
| `reopen` | Undoes `close`. | nothing |
| `doctor` | What the last run did and what it couldn't read. Names, paths and error messages only, no source and no answers, so it's safe to paste into a bug report. | nothing |

`perch findings` also works, same command.

### Issues

`perch issues` lists what the scan found, worst first. Each row is one method,
with the problems the model saw in it and how sure it was. `perch issues <id>`
opens a single one up.

Not every finding is worth acting on. `perch close` takes one off the list:

```sh
perch close e585492e --reason "verifies the HMAC before parsing"
```

A closure stays closed. Later scans and later edits leave it alone, the way a
`.eslintignore` entry does, because perch being wrong about something does not
stop being true when a line above it moves. `perch reopen` is the only thing that
brings it back.

It covers the kinds that were on the issue when you closed it, so a defect found
in that method later is a new thing and is listed. `--kind` closes some of them
and leaves the rest:

```sh
perch close e585492e --kind docs
```

`--filter` narrows a list down to the issues you care about:

```sh
perch issues --filter type=security
perch issues --filter severity=P1
```

## Checking a change

`perch check` puts the questions to one point in the code as it reads on disk,
so you can edit and ask again without committing anything:

```sh
perch check src/model.js::createModel              # every rule that covers it, and the scan's questions
perch check src/model.js::createModel --rules security
perch check 92c7781e                               # whatever raised that issue
```

`--rules` takes rule names out of `perch.yaml` or the classes the scan asks
about, so after a security fix you can ask about security alone. It exits 1 while
something is still wrong, which is what a loop needs.

## Documentation

[docs.perchscan.com](https://docs.perchscan.com)

| | |
| --- | --- |
| [Getting started](https://docs.perchscan.com/install/) | Install, the key, the first scan. |
| [Reading issues](https://docs.perchscan.com/issues/) | The list, the filters, closing what does not matter. |
| [Your own rules](https://docs.perchscan.com/rules/) | Every field `perch.yaml` takes. |
| [Checking a change](https://docs.perchscan.com/check/) | `perch check` on work in progress. |
| [perch in CI](https://docs.perchscan.com/ci/) | What a build can gate on, and what it cannot. |
| [Command reference](https://docs.perchscan.com/cli/) | Every verb and every flag. |
| [How a scan works](https://docs.perchscan.com/scan/) | The graph walk, the questions, and how probabilities turn into a ranking. |

Results go in `<out>`, which is `.perch` by default: `scan.jsonl` holds what the
last run found, one line per method read and per rule broken, rewritten whole
every run. `closed.jsonl` holds what you set aside, which has to survive the next
run. Nothing else is written to your tree.

## Development

```sh
npm run check     # lint, typecheck, test
npm run build     # bundle src/cli.js into dist/cli.mjs
```

From a checkout: `npm install && npm run build && npm link` puts `perch` on your
path.
