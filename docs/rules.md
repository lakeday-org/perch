---
title: Your own rules
nav: Your own rules
group: Using perch
order: 4
summary: Questions you write in perch.yaml, asked in the same reading as perch's own.
---

# Your own rules

A rule is a claim you make about your own code, written as a sentence and put to
the model as a question. They cover what a parser cannot prove: whether a comment
says why, whether a listing honors a filter, whether a test asserts something
real.

They live in `perch.yaml` at the root of the repository.

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

Your rules ride in the request perch was already making about that method, so a
method covered by five rules is one reading, not six. Every question in a request
is scored against the code by itself, and the code is what the request is mostly
made of.

## Fields

| Field | |
| --- | --- |
| `name` | What it is called. Names the row in the table, and is what `--rules` and `--filter kind=` take. |
| `where` | What it covers: a glob, `callers of <method>`, or `mentions <text>`. |
| `except` | A glob it spares. |
| `each` | `file`, `method`, or `test`. A file as a whole is the default. |
| `sees` | What a file or test is shown besides itself: `file`, `calls`, `callers`, or `neighbors`. |
| `ensure` | What has to be true everywhere it covers. |
| `ensure_present` | Something that has to exist somewhere in what it covers. |
| `ensure_absent` | Something that must not exist anywhere in what it covers. |

### `where`

A glob is the common case. The other two forms follow the call graph instead of
the filesystem:

```yaml
where: "src/**/*.js"           # a glob
where: callers of issues       # every method that calls issues()
where: mentions events.jsonl   # every method whose source names that string
```

### `each`

`each: method` asks about every method separately, which is what you want when
the claim is about one method's behavior. Leaving it off asks about the file as a
whole, which is what you want when the claim is about how the file is arranged.
`each: test` asks about each test function.

### `sees`

A method is always read with its callers and callees in view, so a method rule
needs no `sees`. A file or a test is read alone unless you say otherwise, and a
test alone cannot show whether what it asserts is real:

```yaml
sees: calls        # the source of what it calls
sees: callers      # the source of what calls it
sees: neighbors    # both
sees: file         # the whole file it lives in
```

### `ensure` against `ensure_present` and `ensure_absent`

`ensure` has to hold everywhere, so every unit it covers is asked.

`ensure_present` and `ensure_absent` are claims about the codebase rather than
about any one file, so they search the likeliest units first and stop at the
answer. They cost a fraction of what a whole sweep costs.

```yaml
- name: issues-closable
  where: "test/**/*.js"
  each: test
  ensure_present: >
    A test that closes an issue with a reason and then asserts it is gone from
    the default list.

- name: no-dead-command
  where: "src/**/*.js"
  each: method
  ensure_absent: >
    A command or flag that is parsed and then never used.
```

## Writing a good one

A rule is read by a model, so write it the way you would explain it to somebody
joining the team. Say what breaks it, not only what satisfies it:

```yaml
ensure: >
  methods carry a comment that tells a human reader something the code does not.
  A comment that narrates the steps below it, or restates the method's name as a
  sentence, breaks this rule.
```

Rewording a rule re-asks it. Leaving it alone costs nothing.

## Broken rules

A broken rule is listed with everything else, under type `lint`, with the rule's
name in the Kind column:

```console
$ perch issues --filter type=lint
ID        Method       Location          Type  Kind           Severity
b4e21c7a  createModel  src/model.js:29   lint  env-read-once  -
9f03d182  git          src/git.js:10     lint  env-read-once  -
```

`perch scan` exits 1 when a rule is broken. A rule is a claim you made about your
own code, so CI can read that. A finding perch turned up on its own is a
probability, and exiting on one would make every run a coin toss.

## Editing perch.yaml from the command line

`perch rules` changes the file without opening it, keeping your comments and
ordering:

```sh
perch rules list
perch rules add no-stale-docs --where "docs/**/*.md" --ensure_absent "docs for code that was deleted"
perch rules edit env-read-once --except "src/cli.js,src/config.js"
perch rules remove no-stale-docs
```

## Rewording what perch itself asks

The questions perch ships with are written in the same grammar, in `scan.yaml`
inside the package. A rule in `perch.yaml` with the same `name` as one of them
replaces it, so you can reword a question that does not fit your codebase, or add
a class of your own alongside them.

`scan.yaml` is worth reading once. It is the whole set of questions, and it is
the clearest statement of what perch does. See [the questions](/scan/#the-questions).
