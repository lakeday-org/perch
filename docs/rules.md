---
title: Semantic linting
nav: Semantic linting
group: Using perch
order: 4
summary: Your own linting rules in perch.yaml, asked in the same reading as perch's own questions.
---

# Semantic linting

These are the questions a parser leaves open. Whether a comment says why,
whether a listing honors a filter, whether a test asserts something real.

You write the rule as a sentence. perch puts it to the model as a question.

They live in `perch.yaml` at the root of the repository.

## The short form

A rule is its name and the sentence you want held. Everything else has a default:

```sh
perch rules add no-narrative-prose --ensure "A headline and one line, not a paragraph explaining the product."
```

```yaml
- name: no-narrative-prose
  where: "**/*"
  ensure: >-
    A headline and one line, not a paragraph explaining the product.
```

`where` defaults to `**/*`, the answer defaults to a yes-or-no, and the unit
defaults to the file as a whole. Narrow any of them when you need to:

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

| Field | | Default |
| --- | --- | --- |
| `name` | What it is called. Names the row in the table, and is what `--rules` and `--filter kind=` take. | required |
| `ensure` | What has to be true everywhere it covers. | |
| `ensure_present` | Something that has to exist somewhere in what it covers. | |
| `ensure_absent` | Something that must not exist anywhere in what it covers. | |
| `where` | What it covers: a glob, `callers of <method>`, or `mentions <text>`. | `**/*` |
| `except` | A glob it spares. | nothing |
| `each` | `file`, `method`, or `test`. | the file as a whole |
| `sees` | What a file or test is shown besides itself: `file`, `calls`, `callers`, or `neighbors`. | itself |
| `min` | The floor for this rule alone, in percent. | the run's `--min` |
| `gate` | Whether breaking it fails the run. | `true` |
| `disabled` | Keeps the rule in the file without asking it. | `false` |

### `where`

A glob is the common case. The other two forms follow the call graph instead of
the filesystem:

```yaml
where: "src/**/*.js"           # a glob
where: callers of issues       # every method that calls issues()
where: mentions scan.jsonl     # every method whose source names that string
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
ID        Method          Location          Type  Kind                    Severity
99d1b053  src/index.html  src/index.html:7  lint  no-narrative-prose 61%  -
1 open issue match, out of 27
```

`perch scan` exits 3 when a rule is broken, the same as it does on a defect or a
vulnerability perch found itself. All three say something is wrong.

## What fails a run

Every question says whether an answer fails the run or is only worth reading.
`perch rules list` shows it in the Fails column, and yours are read no
differently from perch's own:

```console
$ perch rules list
Question          From        Asks         Fails  Over
comment-says-why  perch.yaml  ensure >65%  yes    src/**/*.js
has_bug           builtin     noul >60%    yes    **/*
refactor          builtin     choice >60%  no     **/*
documented        builtin     noul >75%    no     **/*
```

A rule, a defect and a vulnerability fail by default. A judgement call does not,
because a run nobody can get green is a run people stop reading. `gate:` says
otherwise either way:

```yaml
- name: docs-succinct
  where: "docs/**/*.md"
  gate: false
  ensure: Documentation is kept succinct and deliberate.
```

```sh
perch rules edit refactor --gate true    # make a big method stop a run
perch rules edit docs-succinct --gate false
```

## Code perch does not read

`perch.yaml` is a list of rules. To say what a scan should skip entirely, write it as a
map instead, with the rules under `rules:`:

```yaml
ignore:
  - perch-example/**
  - fixtures/**

rules:
  - name: no-narrative-prose
    where: "**/*.md"
    ensure: A headline and one line, not a paragraph explaining the product.
```

A path matching `ignore` is never read and never reported. This repository uses it for
`perch-example`, an order service with a bug in every method, kept so the docs can show
real output.

The bare list form still works and means what it always did.

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

## How sure perch has to be

Every question carries a floor, in percent. Below it, an answer is not listed.

| Floor | Question |
| --- | --- |
| 75% | `documented` |
| 70% | `does_what_it_claims`, and every defect and vulnerability class |
| 60% | `has_bug`, `refactor` |

A model asked four hundred times answers in the fifties a great deal. A 51% row
reads like a 95% one while being a coin flip. Each floor is where that question
stopped hedging on this codebase. Yours may differ.

`--min` sets a floor for a whole run. Both apply and the higher wins. Asking for
`--min 90` gets you nothing at 73%, whatever a question set for itself.

A rule you write has no floor unless you give it one:

```yaml
- name: comment-says-why
  where: "src/**/*.js"
  each: method
  min: 70
  ensure: A method's comment says what its code cannot.
```

```sh
perch rules edit misdocumented --min 85    # raise a shipped one
perch rules edit comment-says-why --min 0  # take a floor off
```

Raising a floor until a rule keeps nothing is turning it off with extra steps.
When a question answers in the seventies about most of a codebase, the question
is wrong, not the number: see [writing a good one](#writing-a-good-one).

## Answers that are not yes-or-no

`ensure` is shorthand for a yes-or-no question. A rule can instead be written out
in the grammar `scan.yaml` uses, which is what you need when the answer is a pick
from a set or a grade against a rubric.

| Field | |
| --- | --- |
| `type` | `noul` for a probability, `choice` for a pick, `score` for a grade. Default `noul`. |
| `ask` | The question itself, in place of `ensure`. |
| `true` / `false` | What a yes and a no mean, for `noul`. |
| `options` | The options and what each means, for `choice`. |
| `levels` | The rubric, weakest first, for `score`. |
| `when` | Another question this one is only as likely as. The two multiply. |
| `issue` | What an answer means: `type`, `label`, `on`, `pick`, `except`. |
| `gate` | Whether an answer fails the run. Defaults to yes for a defect, a vulnerability or a rule. |

```sh
perch rules add handles_absence --type choice --each method --where "src/**/*.js" \
  --ask "How does this method handle a value that is missing?" \
  --options "checks=It checks for it; ignores=It carries on with the missing value" \
  --issue "type=defect,label=handles_absence,except=checks"
```

`when` is how the scan's own security classes are gated on `exposed`: a class that
only matters if something from outside reaches the method is written
`when: exposed`, and its probability is multiplied by that one's. See
[the questions](/scan/#the-questions).
