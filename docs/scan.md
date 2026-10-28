---
title: Scan internals
nav: Scan internals
group: Reference
order: 9
summary: The parser, the call graph, the questions, and how probabilities become a ranking.
---

# Scan internals

When you run `perch scan`, Perch parses your repository with tree-sitter and builds a call graph of its methods. It then
asks a model the same set of questions about each method. Every answer is a probability, and Perch uses them to rank the
methods by how likely they are to have a serious problem. The only cutoff is [the floor](#the-floor), which controls
which problems are listed.

## 1. tree-sitter

Perch parses every file tracked at `HEAD` with an extension it recognizes, and skips
[dependency, build and cache directories](/rules/#ignored-paths). It supports these languages:

| Group | Languages |
| --- | --- |
| Web | JavaScript, TypeScript, TSX |
| Systems | Rust, Go, C, C++, Zig |
| JVM | Java, Kotlin, Scala, Groovy |
| Scripting | Python, Ruby, PHP, Lua, Bash |
| Other | C#, Swift, Solidity |

Dart and Elixir are not supported, because Perch needs each method's code as one continuous region. Dart's grammar
separates a method's signature from its body, and Elixir's functions are macro calls.

For each named method, Perch records its line range, a hash of its source, and the calls it makes, including functions it
passes as values. It also records five metrics:

| Metric | Meaning |
| --- | --- |
| `risk_score` | 0 to 100, higher is riskier. The walk starts from the riskiest method. |
| `maintainability_index` | 0 to 100, higher is easier to maintain. |
| `cyclomatic_complexity` | The number of decision points. |
| `max_nesting` | The deepest level of block nesting. |
| `sloc` | Lines of code. |

## 2. The call graph

Each node in the call graph is a named method. Perch adds an edge from one method to another when it can resolve a
call:

* to a method with that name in the same file;
* through an import, to a method in another scanned file;
* in Go, to a method in the same directory;
* through a function passed as a value, such as a callback or an event listener, when its name is unique in the
  repository. The model is told that this edge is a handover, where the function is passed on instead of called.

## 3. The walk

Perch uses a stack to decide which method to ask about next:

1. Pop the riskiest method not yet asked about, by `risk_score`, and ask about it.
2. Push its callees and callers, riskiest on top.
3. Push the neighbor the model's `follow` answer picked on top of those.
4. When the stack is empty, start again from step 1.

Perch asks about up to 32 methods at a time. You can change this with `--parallel`. Test methods appear as callers, but
Perch doesn't ask about them unless you pass `--include-tests`. `--paths` and `--since` control which methods a scan
covers, and Perch asks about every method in that scope.

Each scan replaces `.perch/scan.jsonl` with its answers. Perch Cloud caches answers for each repository. If a request
matches one it has already answered, it returns the saved answer at no cost. Changing the method, its callers or callees,
the model, or the wording of any question results in a new request. To ignore the cache, use `--force`.

## 4. The questions

Perch's built-in questions are defined in `scan.yaml`, which ships with Perch. You can override them or add your own in
`perch.yaml`. Method rules that use `ensure` are sent in the same request as Perch's built-in questions, unless they
have a [`context`](/rules/#context) document. Most of a request is the method's code, so each extra question adds very
little to its size.

A question can set `language` to one parser language ID or a list of them. Perch then sends it only for methods in those
languages, and a question without `language` is sent for every language. For example, `cwe_416` (use after free) is sent
for C, C++, Rust and Zig methods, and `cwe_89` (SQL injection) for methods in every language. The IDs follow the
[supported languages](#1-tree-sitter): `c`, `cpp`, `rust`, `javascript`, `typescript`, `tsx`, `c_sharp` and so on.

Each request contains the method and part of the call graph around it. Perch sends the method's source, including the
comment above it, and its metrics. It also sends up to 8 callees and 8 callers, each with its comment and source, and the
calls between them. Perch cuts a long caller down to the lines around its call. If the request is still too large, Perch
shortens each neighbor, then sends fewer of them, down to none, before giving up on the method.

With `--since`, the bug questions `has_bug`, `bug_edge_case`, `kind` and `severity` go in a separate request, and only for
methods the branch changed. That request contains the method's code at the merge base and the diff, both with line numbers,
and no callers or callees. Custom rules and other types of question keep the usual request, for every method in the
changed files, together with `follow`. A method that needs both is sent as two requests.

Apart from the `--since` request, requests don't include the method's position in its file. This means that adding lines
above a method doesn't change its request, so Perch Cloud's cached answers still apply.

If a method is too long to fit in one request, Perch sends it in overlapping parts, each as large as the request limit
allows, and merges the answers. The worst defect found in any pass is the method's defect, and the likeliest security
problem in any pass is its security problem. The first pass includes the callers and callees, so it answers the questions about the method's
design and documentation. If part of a method still could not be sent, `perch issues <id>` says how far Perch read.

If Perch can't get an answer about a method, it records the error against that method and carries on. `perch doctor`
lists those methods with their errors. If every request in two full batches in a row fails, Perch stops the scan, because
that usually means a bad key or a service outage.

Each question uses one of three System One question types. A `noul` returns the probability that a statement is true.
A `choice` picks one option and returns the probability of each. A `score` grades against a scale and returns the
probability of each grade.

| Question | Type | Asks about |
| --- | --- | --- |
| `has_bug` | noul | A functional bug: a wrong result or state, a failed operation, or a false success. |
| `bug_edge_case` | noul | A mishandled empty value, boundary value or alternate branch that the method accepts. |
| `kind` | choice of 9 | The kind of defect. |
| `severity` | score on 4 levels | The harm to a caller, on the scale below. |
| `cwe_*` | up to 30 nouls | One security weakness each: the 2025 MITRE Top 25 except CWE-20, plus six more, filtered by language. |
| `documented` | noul | A comment, or code short enough to read, that tells a caller what the method promises. |
| `refactor` | choice of 7 | The change the method needs most, if any. |
| `follow` | choice of neighbors | The related method to look at next. |

Perch shows the `kind` and `refactor` options with shorter labels, which you can also pass to `--filter kind=`:

| Option | Label |
| --- | --- |
| `boundary` | `off_by_one` |
| `missing_null_handling` | `unhandled_null` |
| `wrong_return` | `wrong_return_value` |
| `swallowed_error` | `error_ignored` |
| `state_mutation` | `bad_state_change` |
| `ordering` | `wrong_order` |
| `resource_leak` | `leak` |
| `wrong_lookup` | `wrong_lookup` |
| `inverted_condition` | `inverted_condition` |
| `split` | `too_big` |
| `flatten` | `too_nested` |
| `simplify_conditions` | `tangled_conditions` |
| `deduplicate` | `duplicated_logic` |
| `rename` | `misnamed` |
| `remove_dead_code` | `dead_code` |

In `scan.yaml`, security questions are named by CWE number, but Perch shows them with a readable label. For example,
`cwe_89` is shown as `sql_injection`, and `cwe_862` as `missing_authorization`. `perch issues --types` lists every label.

Perch sends all of a method's questions in one request when they fit within the model's limits. Each question adds input
tokens, and a large set can take more than one request.

### Severity levels

`severity` grades how much a caller would feel the problem:

| Level | Description | Band |
| --- | --- | --- |
| 0 | No caller would notice | `P3` |
| 1 | A wrong result in a rare case, or one the caller can see and recover from | `P2` |
| 2 | A wrong result or wrong state in ordinary use | `P1` |
| 3 | Data lost, corrupted, or exposed, or a check that should stop someone bypassed | `P0` |

The security questions are separate yes-or-no questions, so one method can be both injectable and leaking a secret.

## 5. Issues

Perch combines the answers into at most one issue of each type per method. Each issue has a probability that it is
real.

A defect's probability is the higher of `has_bug` and `bug_edge_case`, and its label comes from `kind`.

A security issue's probability is the highest answer among the security questions that apply to the method's language.
Security questions are only asked when you use `--filter type=security`, or when `security` is in `scan_types`.

A refactor issue comes from the `refactor` answer, and a docs issue from `documented`. These questions are only asked
when `refactor` or `docs` is in `scan_types`, or when you filter for them.

### The floor

Perch lists an issue only when its probability is above both the question's floor and the scan's `--min`. The bug
questions have an 80% floor on answers from `gpt-6-luna`, OpenAI's Decisions model, and from `perch-latest`, the model
Perch Cloud serves, and 60% on Jev and other models. Most security questions have a 70% floor, and XSS, SQL injection
and out-of-bounds reads have 60%. These probabilities are useful for ranking answers, but they
aren't measured rates of real bugs. A higher floor reports fewer false positives, but misses more real problems.

The floor only affects what is listed:

* Ranking uses every answer. An issue at 49% still adds 0.49 to its method's weight, so there is no sudden jump at the
  floor.
* `perch issues <id> --json` includes the answers below the floor.

To raise the floor for a whole scan, use `--min` with a percentage. `--min 0` lists every answer, ignoring the questions'
own floors.

## 6. Ranking

Perch splits a method's issues into two groups: correctness, which covers defects and security issues, and design, which
covers refactor and docs issues. The total for each group is the sum of its probabilities, so two issues at 50% count the
same as one issue at 100%.

Methods are ranked by this weight:

```
weight = correctness × mean + design
```

Here, `mean` is the average severity level, described below. Design issues aren't weighted by severity, since a refactor or a
missing comment doesn't affect callers.

### The severity formula

The model returns a probability for each of the four severity levels. Level 0 means no caller would notice, and level 3
means data lost, corrupted or exposed. The P bands run the other way, so level 0 is `P3` and level 3 is `P0`.

Perch computes three numbers from those probabilities:

```
mean  = Σ level × p(level)                  0 to 3, worst at 3
band  = [P3, P2, P1, P0][round(mean)]       the label
shown = 3 − mean                            the number in brackets
```

The ranking uses `mean`, `--filter severity=` matches against `band`, and `shown` is the number printed in brackets.
`shown` uses the same scale as the bands, where 0 is the most severe.

For example, `perch issues ddc5c917` in [Reading issues](/issues/) prints `Severity   P1 88%  P0 9%  P2 3%`, which Perch
shows as `P1 (0.9)`:

```
mean  = 2(0.88) + 3(0.09) + 1(0.03) + 0(0.00) = 2.06
band  = [P3, P2, P1, P0][round(2.06)] = [P3, P2, P1, P0][2] = P1
shown = 3 − 2.06 = 0.94, printed as 0.9
```

This means `P1 (0.6)` is close to `P0`, and `P1 (1.4)` is close to `P2`.

The band only shows where the average falls. For example, a spread of P0 33%, P1 31%, P2 30% and P3 6% averages to
`P1 (1.1)`, which is the same band as 88% on P1. The number in brackets distinguishes them, and `perch issues <id>` prints
the full spread.

## 7. Filtering

`--filter` accepts `type=`, `kind=` and `severity=`, which match the columns that describe a problem, and `rule=`, which
matches a rule from `perch.yaml`. If you give more than one value for a key, an issue can match any of them. If you give
more than one key, an issue must match all of them.

When you use `--filter` with `perch scan`, it controls which questions Perch asks, not just which issues it prints. For
example, `--filter rule=<name>` checks only that rule, which is useful for testing a new rule on its own. `kind=off_by_one`
asks `has_bug` and `bug_edge_case`, with `kind` to name the defect and `severity` to rank it. `severity=` asks every
question, since any issue can have that severity.

A filtered list is sorted by the issues that matched. For each key, Perch takes the highest probability among the
matching issues and multiplies those together:

```
strength = max(matching issues for key A) × max(matching issues for key B) × …
```

For example, `--filter type=security` lists the most likely security problem first, and each row shows its security
problem in the Type column.

Filters apply to the listed issues, so floors still apply. `type=security` lists methods that probably have a security
problem, not every method with a security answer above 0%. To narrow the list further, add `--min 80`. To see every
answer, use `--min 0`.
