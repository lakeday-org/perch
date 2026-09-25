---
title: Inside a scan
nav: Inside a scan
group: Reference
order: 9
summary: The graph walk, the questions, and how probabilities turn into a ranking.
---

# Inside a scan

`perch scan` scores every method and ranks them worst first. Every answer is a
probability, and the ranking is arithmetic over all of them. The only cutoff is
[the floor](#the-floor) on what gets listed.

## 1. tree-sitter

Every file tracked at `HEAD` with a known extension is parsed.
[Dependency, build, and cache directories](rules.md#ignored-paths) are excluded.
So are two languages whose methods cannot be spliced
back as one region. Dart splits a signature from its body. Elixir's functions
are macro calls.

| | |
| --- | --- |
| Web | JavaScript, TypeScript, TSX |
| Systems | Rust, Go, C, C++, Zig |
| JVM | Java, Kotlin, Scala, Groovy |
| Scripting | Python, Ruby, PHP, Lua, Bash |
| Other | C#, Swift, Solidity |

For each named method the analyzer records its line range and a hash of its
source. It also records the calls it makes, the identifiers it passes as values,
and five metrics:

| Metric | |
| --- | --- |
| `risk_score` | 0–100, higher is worse. What the walk starts from. |
| `maintainability_index` | 0–100, higher is better. |
| `cyclomatic_complexity` | Decision count. |
| `max_nesting` | Deepest block nesting. |
| `sloc` | Lines of code. |

## 2. The call graph

Nodes are named methods. An edge is drawn when a call resolves:

* to a method in the same file, by name;
* through an import, to a method in another scanned file;
* for Go, to a method in the same directory;
* as a **handover**, when a function is passed as a value. A tool handler, a
  callback, an event listener. These resolve only when the name is unique across
  the repository. The model is told the edge is a handover.

Handover edges are how perch resolves tool handlers. On this repository they
take the graph from 190 edges to 588, and unresolvable callers from 62 to 46.

## 3. The walk

A stack, seeded with the riskiest method by `risk_score`:

1. Pop the riskiest unvisited method and ask about it.
2. Push its unvisited callees and callers, riskiest on top.
3. Push the neighbor the model said to follow above all of them.
4. When the stack empties, take the next riskiest method overall.

Test methods are analyzed, so they can appear as callers, but never questioned.
Up to `--parallel` methods are in flight at once.

Every method in scope is read. Scope comes from `--paths` or `--since`, and
nothing else. There is no cap on how many methods a run reads.

Every reading goes into `scan.jsonl`, rewritten whole each run. What it holds is
what this run says about this commit. A reading carries forward when the request
that produced it would go out word for word the same. That means the method's
source, the neighbours in the state, the endpoint and model, and the wording of
every question including custom rules. A hash on each reading is compared before anything is sent. A rescan
of untouched code costs nothing and reads the same to the percentage.

## 4. The questions

The questions are declared in `scan.yaml`, which perch ships and `perch.yaml` can
reword or add to. Custom rules about a method are asked in that method's
request, beside perch's. Every question is scored against the state by itself,
and the state is most of what the request carries. A method covered by five rules
costs one reading.

A question may set `language` to one parser language ID or a list of them. Perch
only sends that question for methods parsed as one of those languages. Questions
without `language` apply to every parsed language. For example, `cwe_416` is
sent for C, C++, Rust, and Zig methods, while `cwe_89` is sent in every language.
The IDs follow the [supported language list](#1-tree-sitter): `c`, `cpp`,
`rust`, `javascript`, `typescript`, `tsx`, `c_sharp`, and so on.

A request carries the method's source with each line tagged
`L0042|`, the comment above it, and its metrics. It carries the file's imports
and module scope. It also carries up to 8 callees with the names of their own
callees. It carries up to 8 callers with the line where each calls it. When
they do not fit, each neighbour is shortened, then fewer are shown, down to
none, before the method is given up on.

A method too long for one request is read in **overlapping passes**, each sized
to what the budget actually holds. Only lines a pass can see are offered to its
`where` question. The answers merge. The worst defect found anywhere is the
method's defect. A vulnerability is the likeliest reading from any pass. The
first pass carries the callers and callees, so it answers the questions about the
method's shape and its documentation. Eight passes is the cap. A longer method is read in part and says so, on the record and
in `perch issues <id>`. One reading is allowed 64 requests across its passes and
question batches. A reading that would need more is refused before any is sent,
and `perch doctor` lists it.

A method that still cannot be read is recorded against itself and the walk
carries on. `perch doctor` lists them with the error each one failed on. When
nothing can be read at all, two full batches of failures in a row end the run.
That is a bad key, or a service that is down.

Each question uses the System One primitive that fits it. A `noul` is a
probability that something is true. A `choice` picks one option and returns the
distribution over all of them. A `score` grades against a rubric and returns the
distribution over its levels.

| Question | Primitive | |
| --- | --- | --- |
| `has_bug` | noul | A concrete behavioral defect a caller can reach. |
| `where` | choice over line ids | Which line, with confidence. A method longer than 255 lines gets a window chosen first, then a line within it. |
| `kind` | choice over 8 | `boundary`, `missing_null_handling`, `wrong_return`, `swallowed_error`, `state_mutation`, `ordering`, `resource_leak`, `inverted_condition`. |
| `severity` | score over 4 levels | The rubric below. |
| `bug_*` | 15 nouls | Specific behavioral bug types, including boundaries, state, error handling, and concurrency. |
| `security_any` | noul | Any concrete reachable security vulnerability. |
| `cwe_*` | Up to 25 nouls | The 2025 MITRE Top 25 CWEs, filtered by language where needed. |
| `misuse_N` | noul per callee | Does this call violate the callee's evident contract? |
| `misused_by_N` | noul per caller | Does the caller violate this method's contract? |
| `does_what_it_claims` | noul | Does the behavior match the name, parameters, and comment? |
| `documented` | noul | Could a caller learn what it promises from the comment? |
| `refactor` | choice over 7 | `split`, `flatten`, `simplify_conditions`, `deduplicate`, `rename`, `remove_dead_code`, `none`. |
| `follow` | choice over neighbors | Which related method to examine next. |

The names in that table are the IDs written in `scan.yaml`. The specific
security questions are named by CWE, such as `cwe_89` for SQL injection.
`perch issues --types` lists the labels accepted by `--filter kind=`.

System One does not bill output tokens, so asking thirty questions of a method
costs what asking one costs. The whole set rides in one request, up to 128
questions; more than that take a second.

### noul, choice and score

A defect has one kind, so `kind` is a `choice`. The distribution it returns is
what the row prints.

Severity is a rubric, so `severity` is a `score`:

| Level | | Band |
| --- | --- | --- |
| 0 | No caller would notice | `P3` |
| 1 | A wrong result in a rare case, or one the caller can see and recover from | `P2` |
| 2 | A wrong result or wrong state in ordinary use | `P1` |
| 3 | Data lost, corrupted, or exposed, or a check that should stop someone bypassed | `P0` |

The security classes are independent yes/no questions. A method can be both
injectable and leaking a secret.

## 5. Issues

Each answer becomes at most one issue, carrying the probability that it is real.

**A defect** is the strongest of the broad `has_bug` question, the 15 specific
bug checks, and the contract check. The broad result uses the `kind` choice
for its label; the specific checks use their own names.

**A vulnerability** is the strongest answer among `security_any` and the
applicable CWE checks. A memory-safety check does not apply to a language
without native memory operations; the broad security check still does.

**Design issues** are the refactor the `refactor` choice picked, `1 − P(does what
it claims)`, and `docs`.

### The floor

An issue is listed when its probability is over **0.5**. A `noul` is the
probability that something is true, so above a half is the model saying yes.
Printing everything means printing every method in the repository, because no
answer comes back at zero. On perch itself the floor takes 364 listed methods
down to 240, and `--filter type=defect` from 354 to 25.

The floor applies to what is claimed. The arithmetic keeps everything:

* **Ranking counts the whole distribution.** An issue at 49% still weighs 0.49 in
  where its method sorts. There is no cliff at the boundary, only a line below
  which perch stops saying it found something.
* **`perch check` reports the whole distribution too.** Halving a 40% defect is
  visible as that. Neither the before nor the after is listed.

`--min P` moves the line, in percent. `--min 0` prints everything the scan
answered.

## 6. Ranking

Issues split in two. **Correctness** is the defect and the vulnerability;
**design** is the rest. Each side is the sum of its probabilities. Two issues at 50% weigh what one at
100% weighs, and nothing has to cross a line to count.

A method is ranked by what its problems would cost, not how many it has:

```
weight = correctness × mean + design
```

`mean` is the severity distribution's mean, worked out below. It is the only
weighting in the ranking.

Design problems weigh as themselves. They are the ones the rubric's own bottom
level describes: no caller would notice.

### The severity formula

The score comes back as a distribution over the four levels. Level 0 is "no
caller would notice". Level 3 is "data lost, corrupted, or exposed, or a check
that should stop someone bypassed". The bands run the other way, so level 0 is
`P3` and level 3 is `P0`.

Three numbers come out of that distribution:

```
mean  = Σ level × p(level)                  0 to 3, worst at 3
band  = [P3, P2, P1, P0][round(mean)]       the label
shown = 3 − mean                            the same number on the P scale
```

`mean` is what the ranking multiplies by. `band` is the label a filter matches.
`shown` is the number in brackets. It uses the scale the bands are named in,
where 0 is worst and 3 is harmless.

Worked, on the `buildGraph` distribution from
[reading the issues](issues.md), which perch prints as `P1 (1.1)`:

```
Severity   P1 83%   P2 12%   P0 4%   P3 1%
             ↓        ↓        ↓       ↓
  level      2        1        3       0

mean  = 2(0.83) + 1(0.12) + 3(0.04) + 0(0.01) = 1.90
band  = [P3, P2, P1, P0][round(1.90)] = [P3, P2, P1, P0][2] = P1
shown = 3 − 1.90 = 1.1
```

Which is why `P1 (0.9)` is nearly a `P0` and `P1 (1.2)` is settling toward `P2`.

The rubric grades how bad the problem would be for a caller. Its top
level is a vulnerability in so many words. A defect and a vulnerability are both
weighed by it, and both carry the band.

The band names only where the most probability sits. P0 33% / P1 31% / P2 30% /
P3 6% is called `P0` on a third of the mass, and reads as worse than 54% on P1
with 29% on P0. The mean separates them, and `perch issues <id>` prints the
whole distribution.

## 7. Filtering

`--filter` takes `type=`, `kind=` and `severity=`, which are the three columns
that name a problem, and `rule=`, which names one rule from `perch.yaml`.
Clauses on the same key are alternatives; clauses on different keys must all
hold.

A filter narrows the run, not only the report. `--filter rule=<name>` asks that
one rule and skips every unit it does not cover, which is how a rule you have
just written gets run on its own.

A filtered list is also **ranked by what was filtered for**. For each key, perch
takes the highest probability among the issues that match it, then multiplies
those together:

```
strength = max(matching issues in key A) × max(matching issues in key B) × …
```

So `--filter type=security` puts the likeliest vulnerability first. Each row
shows the matching issue first as well: a row selected for a vulnerability does
not show `refactor` in its Type column.

A filter runs over the listed issues, so the floor still applies. `type=security`
gives you the methods probably carrying a vulnerability, not every method that
scored above zero on one. `--min 80` narrows it further.
`--min 0` widens it to everything the scan answered.
