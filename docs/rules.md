---
title: Semantic linting
nav: Semantic linting
group: Using perch
order: 4
summary: Write custom rules as sentences in perch.yaml, and Perch checks them on every scan.
---

# Semantic linting

Custom rules let you check for things a traditional linter can't, such as whether errors reach the caller or whether tests
assert on real behavior. A rule is a plain-English statement that your code should satisfy. Perch asks the model whether
each file, method or test that the rule applies to satisfies the statement, and reports the ones that don't.

Rules are stored in `perch.yaml` at the root of your repository, or in YAML files under `.perch/rules/`.

## Add a rule

To add a rule, use `perch rules add`:

```console
$ perch rules add errors-reach-the-caller --each method --where "**/*.py" --min 65 --ensure "When this method catches an exception, it raises it again or returns a value the caller can tell apart from success. Logging the exception and returning an ordinary value breaks this rule."
Added errors-reach-the-caller to perch.yaml.
```

This adds the following rule to `perch.yaml`:

```yaml
- name: errors-reach-the-caller
  each: method
  where: "**/*.py"
  min: 65
  ensure: >-
    When this method catches an exception, it raises it again or returns a value
    the caller can tell apart from success. Logging the exception and returning
    an ordinary value breaks this rule.
```

In this example, `where` and `each` apply the rule to every method in every Python file, and `min: 65` reports a method
only when Perch is more than 65% confident that it breaks the rule. If you leave out `where`, the rule applies to every
file in the repository. If you leave out `each`, Perch checks each file as a whole.

The next scan checks the rule along with Perch's built-in questions:

```console
$ perch scan storage.py
storage.py
  ID        Line  Severity  Type    Confidence  Problem                  Method
  5a623390    10  -         lint           74%  errors-reach-the-caller  load_order
  5a623390    10  P1 (1.0)  defect         68%  error_ignored            load_order

✖ 2 problems in 1 file, all failing
order-service at commit a71f48f: 3 methods, read 3
3 requests  0 tokens in  $0.0000
```

A broken rule is reported with the type `lint`, and the Problem column shows the rule's name.

Method rules that use `ensure` are checked in the same request as Perch's built-in questions, so adding them doesn't
increase the number of requests. Other rules are sent in separate requests, and so are method rules with a
[`context`](#context) document.

## Rule files

You can keep all of your rules in `perch.yaml`, or split them across `.yaml` and `.yml` files in `.perch/rules/` and its
subdirectories. Each file contains a list of rules in the same format as `perch.yaml`.

Perch reads `perch.yaml` first, and then the files in `.perch/rules/` in alphabetical order. If two rules have the same
name, the one read last takes precedence. Perch reads rule files from disk, so new and edited rules take effect on the
next scan, even before you commit them.

`ignore` and `scan_types` must be set in the root `perch.yaml`. To see which file each rule is in, run
`perch rules list`.

Commit `.perch/rules/` and `.perch/closed.jsonl` to your repository. Each scan writes a `.perch/.gitignore` file that
ignores the rest of Perch's output. If your root `.gitignore` ignores `.perch`, replace that entry with:

```gitignore
.perch/*
!.perch/closed.jsonl
!.perch/rules/
```

## Fields

A rule must have a `name` and one of `ensure`, `ensure_present` or `ensure_absent`. The other fields are optional.

| Field | Description | Default |
| --- | --- | --- |
| `name` | The rule's name. It's shown in the Problem column, and you can pass it to `--rules`, `--filter rule=` and `--filter kind=`. | required |
| `ensure` | A statement that must be true of everything the rule applies to. | |
| `ensure_present` | Something that must exist somewhere in what the rule applies to. | |
| `ensure_absent` | Something that must not exist anywhere in what the rule applies to. | |
| `where` | What the rule applies to: a glob, `callers of <method>`, or `mentions <text>`. | `**/*` |
| `except` | A glob for paths to skip. | none |
| `each` | Check each `file`, `method` or `test` separately. | each file as a whole |
| `sees` | Additional context to send with a file or test: `file`, `calls`, `callers` or `neighbors`. | none |
| `context` | A document to send with each file, method or test, such as a style guide. See [context](#context). | none |
| `min` | The minimum confidence, in percent, for reporting a break. You can also set one per model. See [Floors](#floors). | the scan's `--min`, which defaults to 50 |
| `gate` | Whether a break fails the scan. | `true` |
| `disabled` | Keeps the rule in the file without checking it. | `false` |

### where

`where` is usually a glob. The other two forms select methods using the call graph instead of file paths:

```yaml
where: "src/**/*.js"           # Every file that matches the glob.
where: callers of issues       # Every method that calls issues().
where: mentions scan.jsonl     # Every method whose source contains "scan.jsonl".
```

### each

`each: method` checks every method separately. Use it for rules about how a method behaves. Without `each`, Perch checks
each file as a whole, which is better for rules about how a file is organized.

`each: test` checks every test that Perch can parse, including pytest and `unittest` tests, `it` and `test` blocks in
JavaScript and TypeScript, `#[test]` functions in Rust, JUnit `@Test` methods, and GoogleTest and Catch2 test macros in
C++. Perch finds tests in any file, so a test rule doesn't need `where`, although you can use `where` to limit which tests
it checks. Rules with `each: method` skip tests and the helper methods next to them.

### sees

Perch always sends a method's callers and callees with it, so method rules don't need `sees`. Files and tests are sent on
their own unless you set `sees`. For example, a rule about tests usually needs to see the code being tested:

```yaml
sees: calls        # The code it calls.
sees: callers      # The code that calls it.
sees: neighbors    # Both.
sees: file         # The whole file it's in.
```

`calls` and `callers` follow the call graph outward, starting with the nearest methods, up to a limit of eight. For a
test, `sees: calls` sends the code the test calls. For a file, Perch starts from the methods declared in that file.

Files that Perch can't parse for methods, such as Markdown and YAML, have no call graph. For these files, `calls` sends
the files in the same directory and below it, and `callers` sends the files in the directories above it.

### context

`context` sends a reference document, such as a style guide, with each file, method or test that the rule checks. For an
example, see [Cite a reference document](#cite-a-reference-document).

If `context` contains a slash, such as `.perch/rules/code-style.md`, it's a path from the root of the repository. The
scan fails if that file doesn't exist.

If `context` is a file name without a slash, Perch uses the nearest file with that name. It looks in the directory of the
code being checked first, and then in each directory above it. You can use this to give each part of a repository its own
document:

```yaml
- name: billing-words
  where: "src/**/*.js"
  context: LANGUAGE.md
  ensure: >-
    The code uses the words LANGUAGE.md says to use, and none of the words it
    says to avoid.
```

In this example, `src/billing/invoice.js` is checked with `src/billing/LANGUAGE.md`, and a file in a directory without
its own `LANGUAGE.md` is checked with the nearest one above it. If no directory above a file has a `LANGUAGE.md`, the
rule doesn't check that file.

When the document changes, Perch checks everything that uses it again. With `--since`, a branch that changes only the
document is enough. `perch check` reads the document from disk, so it includes changes you haven't committed.

Note: a method rule with `context` isn't checked in the same request as Perch's built-in questions. Perch sends a
separate request for each method, with the method's callers and callees, so the rule costs one request per method.

### ensure, ensure_present and ensure_absent

An `ensure` rule must be true of everything it applies to, so Perch checks every file, method or test that matches.

An `ensure_absent` rule is also checked against everything it applies to. Perch reports each file, method or test that
has the thing the rule describes.

`ensure_present` is a statement about the codebase as a whole. Perch checks the most likely candidates first, and stops
at the first one that has the thing the rule describes. For example:

```yaml
- name: issues-closable
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

An `ensure_present` rule is cheap when the thing exists, because Perch stops as soon as it finds it. When it doesn't
exist, Perch checks everything the rule applies to before it reports the rule as broken. An `ensure_absent` rule always
checks everything it applies to, so the `no-dead-command` rule above checks every method in `src`.

With `--since`, a rule applies only to the code that the branch changed.

To see how much a single rule costs, run it on its own with `perch scan --filter rule=<name>`.

You can make a rule cheaper by narrowing `where` to the part of the code it's about. For example, this rule from Perch's
own `perch.yaml` applies only to the few methods that call `issues()`, instead of every method under `src`:

```yaml
- name: closed-never-listed
  where: callers of issues
  ensure: >
    This method passes the findings through visibleFindings before a person
    sees them, or it is not producing a list for a person to read.
```

## Write a good rule

The model reads your rule as written, so write it the way you'd explain it to a new teammate. Include an example of what
breaks the rule, not only what follows it:

```yaml
ensure: >
  The method has a comment that tells the reader something the code does not.
  A comment that narrates the steps below it breaks this rule, and so does one
  that restates the method's name as a sentence.
```

If you're writing a rule for whole files, these guidelines help:

- Limit the rule to a fixed part of the file, such as "the first four paragraphs". A rule like "every sentence is short"
  is more likely to fail on a long file, whatever the writing is like.
- If a rule scores in the 50s on almost everything, it isn't telling good code from bad. Reword it or remove it instead of
  raising its floor.

When you change a rule's wording, Perch checks it again on the next scan. Unchanged rules on unchanged code are answered
from Perch Cloud's cache and cost nothing.

## Cite a reference document

If several rules depend on the same conventions, you can write the conventions down once in a document, such as a style
guide, and cite the document from each rule with [`context`](#context). Perch sends the document with everything the rule
checks, so the rule can refer to a section of the document instead of repeating it.

For example, Perch's own repository keeps its code conventions in `.perch/rules/code-style.md`:

```markdown
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
```

Two rules in its `perch.yaml` cite the guide, and each one names the section that applies:

```yaml
- name: no-silent-failure
  where: "src/**/*.js"
  each: method
  context: .perch/rules/code-style.md
  min: 80
  ensure: >-
    Find each catch block and each .catch() callback in this method's own
    body, not in the callers and callees shown with it; if it has none, this
    rule holds, whatever else the method does. Each one handles the error as
    the Errors section of the style guide says. One that swallows it breaks
    this rule.

- name: tests-assert-real-behavior
  where: "test/**/*.js"
  context: .perch/rules/code-style.md
  ensure: >-
    Read the first three tests in this file. Each asserts on what code from
    src/ did, as the Tests section of the style guide says. A test whose
    assertions would still pass if the code under test did nothing breaks
    this rule. A file that defines no tests satisfies this rule.
```

In this example, the details of what each rule allows are in the style guide, and the rules stay short. To change what a
rule allows, edit the guide. On the next scan, Perch checks the code that the guide applies to again.

To add a rule that cites a document from the command line, use `--context`:

```sh
perch rules add no-silent-failure --each method --where "src/**/*.js" --context .perch/rules/code-style.md --ensure "Each catch block handles the error as the Errors section of the style guide says."
```

These guidelines help when you cite a document:

- Name the section the rule depends on, such as "the Errors section of the style guide".
- Keep the document short. Perch sends it with every file, method or test the rule checks. If the document doesn't fit
  in the request next to the code, Perch sends only the beginning of it.
- Keep the document in `.perch/rules/`. Rules don't check files in that directory, so the examples of what not to do in
  your guide aren't reported as problems.

## Broken rules

To list the methods and files that break a rule, filter `perch issues` by type:

```console
$ perch issues --filter type=lint
ID        Method      Location       Type  Kind                                            Severity
5a623390  load_order  storage.py:10  lint  errors-reach-the-caller 74%, error_ignored 68%  P1 (1.0)
1 open issue match, out of 9
```

`perch scan` exits with code 3 when a rule is broken, the same as it does for a bug or a security problem.

## Gates

Every question a scan asks, including your custom rules, fails the scan when it finds a problem. `perch rules list`
shows this in the Fails column:

```console
$ perch rules list
Question                 From        Asks         Fails  Over     Description
errors-reach-the-caller  perch.yaml  ensure >65%  yes    **/*.py  When this method catches an
                                                                  exception, it raises it again
                                                                  or returns a value the caller
                                                                  can tell apart from success.
                                                                  Logging the exception and
                                                                  returning an ordinary value
                                                                  breaks this rule.
has_bug                  builtin     noul >60%    yes    **/*     Does `method` contain a
                                                                  functional bug?
```

The full output also lists the rest of Perch's built-in questions.

If you want Perch to report a rule without failing the scan, set `gate: false`:

```yaml
- name: docs-succinct
  where: "docs/**/*.md"
  gate: false
  ensure: Documentation is kept succinct and deliberate.
```

You can make the same change with `perch rules edit docs-succinct --gate no`. To stop checking a whole type of problem,
remove it from [`scan_types`](#issue-types).

## Ignored paths

Perch skips common dependency, build and cache directories in every language, at any depth. This applies to method
scans, file and test rules, searches, and the callers and callees sent to the model.

| Ecosystem | Directories |
| --- | --- |
| Shared | `vendor`, `third_party`, `third-party`, `thirdparty`, `3rdparty`, `build`, `dist`, `out`, `target`, `coverage`, `.cache` |
| JavaScript and frontend | `node_modules`, `.next`, `.nuxt`, `.output`, `.svelte-kit`, `.angular`, `.parcel-cache`, `.turbo`, `.yarn/cache`, `.yarn/unplugged` |
| Python | `.venv`, `venv`, `site-packages`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tox`, `.nox` |
| JVM and Android | `.gradle`, `.bloop`, `.metals`, `.scala-build`, `.cxx`, `.externalNativeBuild` |
| C and C++ | `CMakeFiles`, `cmake-build-*`, `_deps`, `bazel-bin`, `bazel-out`, `bazel-testlogs` |
| Swift and Objective-C | `.build`, `Pods`, `DerivedData`, `Carthage/Build`, `Carthage/Checkouts` |
| Rust and Zig | `target`, `.zig-cache`, `zig-cache`, `zig-out` |
| Dart and Flutter | `.dart_tool`, `.pub-cache`, `.pub` |
| Haskell, Elixir, Erlang and OCaml | `.stack-work`, `dist-newstyle`, `.cabal-sandbox`, `_build`, `.elixir_ls` |
| Other package and tool caches | `lua_modules`, `blib`, `.precomp`, `renv/library`, `renv/staging`, `packrat/lib`, `.cpcache`, `.godot`, `.import` |

Some directory names are also used for source code, so Perch only skips them when they're next to a matching project
file:

| Project file | Directories skipped next to it |
| --- | --- |
| `*.csproj`, `*.fsproj`, `*.vbproj` | `bin`, `Bin`, `obj`, `Obj` |
| `mix.exs`, `rebar.config` | `deps` |
| `hardhat.config.js`, `.ts`, `.cjs`, `.mjs`, `.cts` or `.mts` | `cache`, `artifacts` |
| `foundry.toml` | `cache`, `broadcast` |
| `*.uproject` | `Binaries`, `Intermediate`, `Saved` |

In a Unity project, identified by `ProjectSettings/ProjectVersion.txt`, Perch skips `Library`, `Temp`, `Obj`, `Logs`,
`UserSettings` and `Builds` at the project root. It also skips any directory below the repository root that contains a
committed `pyvenv.cfg` file. Elsewhere, directories such as `bin`, `lib`, `packages` and `deps` are scanned normally.

Perch skips generated files the same way GitHub does:

- Minified JavaScript and TypeScript files, such as `.min.js`, and any JavaScript or CSS file whose lines average more
  than 110 characters or that ends with a `sourceMappingURL` comment.
- Files with a generator's marker in their first 40 lines, such as `// Code generated by … DO NOT EDIT.`, `@generated`,
  or the headers written by protobuf, gRPC, Thrift and Cython.

Your `.gitattributes` file takes precedence. Perch skips paths marked `linguist-generated` or `linguist-vendored`, and
scans paths marked `-linguist-generated` or `linguist-vendored=false`, even if it would otherwise skip them:

```gitattributes
public/js/** linguist-generated
vendor/our-fork/** -linguist-vendored
```

Large source files aren't skipped. Perch splits them into parts instead.

### Ignore other paths

To skip other paths, add them to `ignore` in `perch.yaml`. When you use `ignore`, `perch.yaml` must be a map, with your
rules under `rules:`:

```yaml
ignore:
  - generated/**
  - fixtures/**

rules:
  - name: errors-reach-the-caller
    where: "**/*.py"
    each: method
    ensure: When this method catches an exception, it raises it again or returns an error.
```

Paths that match `ignore` are skipped when you scan the whole repository. If you name an ignored path directly, as in
`perch scan fixtures/` or `--paths fixtures`, Perch scans it anyway. A `perch.yaml` that contains only a list of rules
still works.

## Issue types

`scan_types` in `perch.yaml` controls which types of problem a scan checks for. It defaults to `[defect, lint]`, which
covers Perch's bug questions and your custom rules. You can also add `security`, `refactor` and `docs`. Every type you
add can fail a scan, just like the defaults. For example:

```yaml
scan_types: [defect, security, lint]

rules:
  - name: errors-reach-the-caller
    where: "**/*.py"
    each: method
    ensure: When this method catches an exception, it raises it again or returns an error.
```

The list replaces the default, so `scan_types: [security]` checks for security problems and nothing else.

To check for a type on a single scan, use `--filter type=`. This works whatever `scan_types` is set to:

```console
$ perch scan cart.py --filter type=refactor
✓ nothing matching type=refactor, out of 3 problems found
order-service at commit a71f48f: 4 methods, read 4
4 requests  4k tokens in / 296 out  $0.0004
```

`--filter` controls which questions Perch asks, so this scan asked only the refactoring question. The three problems it
mentions are bugs that earlier scans found in `cart.py`.

## perch rules

`perch rules` lets you manage rules from the command line. `perch rules list` shows every rule and the file it's in,
followed by Perch's built-in questions. `add` writes to `perch.yaml`, or to the file under `.perch/rules/` that you name
with `--file`, creating the file if it doesn't exist. `edit` and `remove` find the file a rule is in. All three keep the
file's comments and order.

```sh
perch rules list                                       # List every rule.
perch rules list --file .perch/rules/docs.yaml         # List the rules in one file.
perch rules add no-stale-docs --where "docs/**/*.md" --ensure_absent "docs for code that was deleted"
perch rules add docs-no-rationale --file .perch/rules/docs.yaml --where "docs/**/*.md" --ensure "..."
perch rules edit errors-reach-the-caller --except "scripts/**"
perch rules remove no-stale-docs
```

## Override built-in questions

Perch's built-in questions are written in the same format, in the `scan.yaml` file that ships with Perch. If a rule in
`perch.yaml` or `.perch/rules/` has the same `name` as a built-in question, it replaces that question. You can use this to
reword a question that doesn't suit your codebase, or to add a new type of question.

For the full list of built-in questions, see [The questions](/scan/#4-the-questions).

## Floors

A floor is the minimum confidence Perch needs before it reports a problem. Each built-in question has its own floor:

| Floor | Questions |
| --- | --- |
| 75% | `documented` |
| 70% | Most security questions |
| 60% | `has_bug`, `bug_edge_case`, `refactor`, `cwe_79` (XSS), `cwe_89` (SQL injection), `cwe_125` (out-of-bounds read) |

Confidence is the model's own estimate, not a measured rate of real bugs. A higher floor reports fewer false positives,
but misses more real problems.

To set a floor for a single scan, use `--min`. If a question also has its own floor, Perch uses the higher of the two. For
example, with `--min 90`, a 73% answer isn't reported, whatever the question's own floor is.

A custom rule without `min` uses the scan's `--min`, which defaults to 50. Without `min: 65`, the example rule on this
page also reported seven methods that don't catch any exceptions, at 51% to 62%. For that reason, give each new rule a
floor:

```yaml
- name: comment-says-why
  where: "src/**/*.js"
  each: method
  min: 70
  ensure: A method's comment says something its code cannot.
```

You can also change floors from the command line:

```sh
perch rules edit documented --min 85        # Raise the floor of a built-in question.
perch rules edit comment-says-why --min 0   # Remove a floor.
```

To use a different floor depending on which model answered, set `min` to a map of model ID prefixes, with `default` for
every other model:

```yaml
min:
  gpt-6-luna: 80
  default: 60
```

If more than one prefix matches a model ID, the longest one is used.

## Longhand questions

`ensure` is a shorthand for a yes-or-no question. For other kinds of answer, such as picking from a list or grading on a
scale, you can write the rule in the same format that `scan.yaml` uses:

| Field | Description |
| --- | --- |
| `type` | `noul` for a yes-or-no probability, `choice` to pick one of several options, or `score` for a grade. Defaults to `noul`. |
| `ask` | The question. Use it instead of `ensure`. |
| `true` / `false` | What a yes and a no mean, for `noul`. |
| `options` | The options and what each one means, for `choice`. |
| `levels` | The grades, lowest first, for `score`. |
| `when` | Another question this one depends on. Perch multiplies the two probabilities. |
| `language` | A parser language ID, or a list of them. The question is only asked about methods in those languages. |
| `issue` | What an answer means: `type`, `label`, `on`, `pick`, `except`. |
| `gate` | Whether an answer fails the scan. Defaults to `true` for a defect, a security problem or a rule. |

For example:

```sh
perch rules add handles_absence --type choice --each method --where "src/**/*.js" \
  --ask "How does this method handle a value that is missing?" \
  --options "checks=It checks for it; ignores=It carries on with the missing value" \
  --issue "type=defect,label=handles_absence,except=checks"
```

This rule reports a defect labelled `handles_absence` when the model picks any option other than `checks`. To ask a
question only about certain languages, add `language`. For example, `language: [c, cpp, rust]` limits it to methods in
C, C++ and Rust. Without `language`, the question applies to every method that `where` selects.
