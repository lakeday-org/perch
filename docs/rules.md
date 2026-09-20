---
title: Semantic linting
nav: Semantic linting
group: Using perch
order: 4
summary: Custom linting rules in perch.yaml, asked in the same reading as perch's own questions.
---

# Semantic linting

A rule is a sentence about what the code should hold. A comment should say why.
A listing should honor a filter. A test should assert something real.

You write the rule as a sentence. perch puts it to the model as a question.

They live in `perch.yaml` at the root of the repository.

## The short form

A rule is its name and the sentence you want held. Everything else has a default:

```console
$ perch rules add no-narrative-prose --ensure "A headline and one line, not a paragraph explaining the product."
Added no-narrative-prose.
```

That is what it appended to `perch.yaml`:

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

Custom rules ride in the request perch was already making about that method. A
method covered by five rules costs one reading. Every question is scored against
the code by itself, and the code is most of what the request carries.

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

`each: method` asks about every method separately. Use it when the claim is about
one method's behavior. Leaving it off asks about the file as a whole, which suits
a claim about how the file is arranged. `each: test` asks about each test
function.

### `sees`

A method is always read with its callers and callees in view, so a method rule
needs no `sees`. A file or a test is read alone unless you say otherwise. A test
alone leaves you guessing whether what it asserts is real:

```yaml
sees: calls        # what it calls
sees: callers      # what calls it
sees: neighbors    # both
sees: file         # the whole file it lives in
```

`calls` and `callers` walk the call graph outward from the unit, nearest first.
What it calls directly comes before what that calls. Eight is the cap, so it cuts
the far edge and keeps the near one. A file walks from the methods it declares.

A file the parser does not read has no methods and no call graph. Markdown and
YAML walk the file tree instead. `calls` is what sits under the file's directory,
shallowest first. `callers` is what sits above it, nearest first.

### `ensure` against `ensure_present` and `ensure_absent`

`ensure` has to hold everywhere, so every unit it covers is asked.

`ensure_present` and `ensure_absent` are claims about the codebase rather than
any one file. They search the likeliest units first and stop at the answer, for a
fraction of a whole sweep.

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

## Wording a rule

A rule is read by a model. Write it the way you would explain it to somebody
joining the team, and say what breaks it:

```yaml
ensure: >
  methods carry a comment that tells a human reader something the code does not.
  A comment that narrates the steps below it breaks this rule. So does one that
  restates the method's name as a sentence.
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

`perch scan` exits 3 when a rule is broken. It does the same for a defect or a
vulnerability.

## Gates

Every question a scan asks fails the run. `perch rules list` shows it in the
Fails column, and a custom rule is read no differently from perch's own:

```console
$ perch rules list
Question                     From        Asks            Fails  Over
has_bug                      builtin     noul >60%       yes    **/*
refactor                     builtin     choice >60%     yes    **/*
documented                   builtin     noul >75%       yes    **/*
```

There is no type that gets asked about and cannot fail. A run that reports
something and passes anyway teaches people to read past it. If a type is not
worth stopping for, leave it out of [`scan_types`](#issue-types) and do not ask
about it.

`gate: false` turns one question off, for the case where you want the answer
recorded and not acted on:

```yaml
- name: docs-succinct
  where: "docs/**/*.md"
  gate: false
  ensure: Documentation is kept succinct and deliberate.
```

```sh
perch rules edit docs-succinct --gate false
```

## Ignored paths

`perch.yaml` is a list of rules. To say what a scan should skip entirely, write it as a
map instead, with the rules under `rules:`:

```yaml
ignore:
  - generated/**
  - fixtures/**

rules:
  - name: no-narrative-prose
    where: "**/*.md"
    ensure: A headline and one line, not a paragraph explaining the product.
```

A path matching `ignore` is never read and never reported.

The bare list form still works.

## Issue types

A scan asks about defects, vulnerabilities and rules.

`refactor` and `docs` read the same on every method that has ever been long. A
scan of this repository reported 32 of them against 0 defects, so they are asked
only when you say so. Asked, they fail a run like anything else:

```yaml
scan_types: [defect, security, lint, refactor, docs]

rules:
  - name: no-narrative-prose
    where: "**/*.md"
    ensure: A headline and one line, not a paragraph explaining the product.
```

The list is the whole set, not an addition to the defaults. `scan_types:
[security]` asks about vulnerabilities and nothing else.

A filter asks for a type whichever way `scan_types` is written:

```console
$ perch scan src/meter.js --filter type=refactor
✓ nothing to report
perch at commit 54a38d6: 13 methods, read 13
13 requests  33k tokens in / 3k out  $0.0014
```

That is 13 requests against 52 for the default run, because the filter narrows
what is asked and not just what is printed.

## perch rules

`perch rules` changes the file without opening it, keeping comments and
ordering:

```sh
perch rules list
perch rules add no-stale-docs --where "docs/**/*.md" --ensure_absent "docs for code that was deleted"
perch rules edit env-read-once --except "src/cli.js,src/config.js"
perch rules remove no-stale-docs
```

## Overriding perch's own questions

The questions perch ships with are written in the same grammar, in `scan.yaml`
inside the package. A rule in `perch.yaml` sharing a `name` with one of them
replaces it. Reword a question that fits a codebase badly, or add a custom class
alongside them.

`scan.yaml` is worth reading once. It is the whole set of questions, and it is
the clearest statement of what perch does. See [the questions](/scan/#the-questions).

## Floors

Every question carries a floor, in percent. Below it, an answer is not listed.

| Floor | Question |
| --- | --- |
| 75% | `documented` |
| 70% | `does_what_it_claims`, and every defect and vulnerability class |
| 60% | `has_bug`, `refactor` |

A 51% answer is a coin flip that prints like a claim, so each question carries a
floor under which perch does not list it. The floors above were set against this
codebase; another may want different ones.

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
A question answering in the seventies about most of a codebase is a wrong
question, not a wrong number. See [writing a good one](#wording-a-rule).

## Longhand questions

`ensure` is shorthand for a yes-or-no question. A rule can instead be written out
in the grammar `scan.yaml` uses. Reach for that when the answer is a pick from a
set, or a grade against a rubric.

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

`when` is how the scan's own security classes are gated on `exposed`. A class
that only matters when something from outside reaches the method is written
`when: exposed`. Its probability is multiplied by that one's. See
[the questions](/scan/#the-questions).
