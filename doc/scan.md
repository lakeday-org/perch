# How a scan works

`perch scan` scores every method and ranks them worst first. Every answer is a
probability, and the ranking is arithmetic over all of them. The only cutoff is
[the floor](#the-floor) on what gets listed.

## 1. tree-sitter

Every file tracked at `HEAD` with a known extension is parsed. Vendored and
built files are excluded, as are two languages whose methods cannot be spliced
back as one region: Dart, whose signature splits from its body, and Elixir,
whose functions are macro calls.

JavaScript, TypeScript, TSX, Python, Rust, Go, Java, Kotlin, Scala, Groovy, C,
C++, C#, Ruby, PHP, Lua, Swift, Zig, Solidity, Bash.

For each named method the analyzer records its line range, a hash of its source,
the calls it makes, the identifiers it passes as values, and five metrics:

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
* as a **handover**, when a function is passed as a value rather than called —
  a tool handler, a callback, an event listener. These resolve only when the
  name is unique across the repository, and the model is told the edge is a
  handover rather than a call site.

Handover edges are how perch sees its own tool handlers. Without them the graph
had 190 edges and 62 methods with no resolvable caller; with them, 588 and 46.

## 3. The walk

A stack, seeded with the riskiest method by `risk_score`:

1. Pop the riskiest unvisited method and ask about it.
2. Push its unvisited callees and callers, riskiest on top.
3. Push the neighbour the model said to follow above all of them.
4. When the stack empties, take the next riskiest method overall.

Test methods are analyzed, so they can appear as callers, but never questioned.
Up to `--parallel` methods are in flight at once.

Each answered method is appended to `events.jsonl` with its hash. A method whose
hash still matches its last reading is skipped without a request — the walk
still passes through it to reach its neighbours. Editing it makes it readable
again; `--force` ignores the log entirely. `ANSWERS_VERSION` does the same when
the question set itself changes, so a method answered by an older set is read
again rather than compared against questions that did not exist.

## 4. The questions

One HTTP request per method. The state carries the method with its lines tagged
`L0042|`, the comment above it, its metrics, its file's imports and module
scope, the source of up to 8 callees with the names of their own callees, up to
8 callers with the line where each calls it, and the call edges among all of
them — trimmed to stay under 48KB.

A method too long for one request is read in **overlapping passes**, each sized
to what the budget actually holds. Only lines a pass can see are offered to its
`where` question. The answers merge: the worst defect found anywhere is the
method's defect, a vulnerability is the likeliest reading from any pass, and the
first pass — the one carrying the callers and callees — speaks for the method's
shape and documentation. Eight passes is the cap; a method longer than that is
read in part and says so, on the record and in `perch issues <id>`.

A method that still cannot be read is recorded against itself and the walk
carries on; `perch doctor` lists them with the error each one failed on. If
nothing can be read at all — a bad key, a service that is down — two full
batches of failures in a row ends the run.

Each question uses the System One primitive that fits it. A `noul` is a
probability that something is true. A `choice` picks one option and returns the
distribution over all of them. A `score` grades against a rubric and returns the
distribution over its levels.

| Question | Primitive | |
| --- | --- | --- |
| `has_bug` | noul | A concrete behavioural defect a caller can reach. |
| `where` | choice over line ids | Which line, with confidence. A method longer than 255 lines gets a window chosen first, then a line within it. |
| `kind` | choice over 8 | `boundary`, `missing_null_handling`, `wrong_return`, `swallowed_error`, `state_mutation`, `ordering`, `resource_leak`, `inverted_condition`. |
| `severity` | score over 4 levels | The rubric below. |
| `exposed` | noul | Does anything from outside the program reach this method, or does it act on the world outside? |
| `security_*` | 16 nouls | `injection`, `path_traversal`, `unsafe_deserialization`, `secret_exposure`, `missing_authorization`, `unvalidated_destination`, `resource_exhaustion`, `unsafe_reflection`, `disabled_safeguard`, `weak_crypto`, `buffer_overflow`, `use_after_free`, `uninitialized_use`, `integer_overflow`, `race_condition`, `type_confusion`. |
| `misuse_N` | noul per callee | Does this call violate the callee's evident contract? |
| `misused_by_N` | noul per caller | Does the caller violate this method's contract? |
| `does_what_it_claims` | noul | Does the behaviour match the name, parameters, and comment? |
| `misdocumented` | noul | Could a caller not learn the contract from the comment? |
| `refactor` | choice over 7 | `split`, `flatten`, `simplify_conditions`, `deduplicate`, `rename`, `remove_dead_code`, `none`. |
| `follow` | choice over neighbours | Which related method to examine next. |

System One does not bill output tokens, so asking thirty questions of a method
costs what asking one costs. That is why the set is wide rather than staged.

### Why these primitives

`kind` was once eight independent yes/no questions. It is a pick-one — a defect
has a kind — so it is a `choice`, and the distribution it returns is what the
row prints.

`severity` was once three yes/no questions, and before that a single rating. It
is a rubric, so it is a `score`:

| Level | | Band |
| --- | --- | --- |
| 0 | No caller would notice | `P3` |
| 1 | A wrong result in a rare case, or one the caller can see and recover from | `P2` |
| 2 | A wrong result or wrong state in ordinary use | `P1` |
| 3 | Data lost, corrupted, or exposed, or a check that should stop someone bypassed | `P0` |

The security classes stay independent yes/no questions, because they are: a
method can be both injectable and leaking a secret.

## 5. Issues

Each answer becomes at most one issue, carrying the probability that it is real.

**A defect** is `has_bug`, labelled with the likeliest kind. The kind does not
discount it: multiplying the two would say a method certainly broken but of
uncertain kind is only half broken.

**A vulnerability** is the likeliest security class. Eight of the sixteen need
something from outside to reach the method, so those are a joint probability:

```
P(vulnerable) = P(class) × P(exposed)
```

The other eight — memory safety, concurrency, type confusion, weak crypto — are
wrong whoever the caller is, and are not gated. Gating them once hid a planted
double-free scored `use_after_free 95%` behind `exposed 46%`.

**Design issues** are the refactor the `refactor` choice picked, `1 − P(does what
it claims)`, and `docs`.

### The floor

An issue is listed when its probability is over **0.5**. That is not a number
picked to make the list a nice length. A `noul` is the probability that something
is true, so above a half is the model saying yes and below it is the model saying
no; printing everything means printing every method in the repository, because no
answer ever comes back at zero. On perch itself the floor takes 364 listed
methods down to 240, and `--filter type=defect` from 354 to 25.

It is a floor on what is claimed, not on the arithmetic:

* **Ranking counts the whole distribution.** An issue at 49% still weighs 0.49 in
  where its method sorts, so there is no cliff at the boundary — only a line
  below which perch stops saying it found something.
* **A fix is judged on the whole distribution too.** Halving a 40% defect counts
  for exactly that, even though neither the before nor the after is listed. See
  [fix.md](fix.md).

`--min P` moves the line, in percent. `--min 0` prints everything the scan
answered.

## 6. Ranking

Issues split in two. **Correctness** is the defect and the vulnerability;
**design** is the rest. Each side is the sum of its probabilities, so two issues
at 50% weigh what one at 100% weighs and nothing has to cross a line to count.

A method is ranked by what its problems would cost, not how many it has:

```
weight = correctness × predicted_severity + design
```

`predicted_severity` is the mean of the severity score's distribution, 0 to 3.
This is the only weighting in the ranking, and it is measured rather than
chosen — the number it replaced was a `× 2` somebody made up.

Design problems weigh as themselves. They are the ones the rubric's own bottom
level describes: no caller would notice.

### Reading the severity column

The band is the mean, rounded. The number beside it is the mean itself, on the
same scale:

```
P1 (0.9)   almost P0
P1 (1.2)   settling toward P2
```

Naming a method by the band holding the most probability throws the rest away.
A spread of P0 33% / P1 31% / P2 30% / P3 6% is called `P0` on the strength of a
third of the mass, and reads as worse than a method with 54% on P1 and 29% on
P0 that is in fact expected to do more damage. The mean says so; the label does
not. `perch issues <id>` prints the whole distribution.

## 7. Filtering

`--filter` takes `type=`, `kind=` and `severity=`, which are the three columns
that name a problem. Clauses on the same key are alternatives; clauses on
different keys must all hold.

A filtered list is also **ranked by what was filtered for**, since ranking it by
overall weight would bury the strongest match. Within a key the likeliest
matching issue speaks for it; across keys they multiply:

```
strength = max(matching issues in key A) × max(matching issues in key B) × …
```

So `--filter type=security` leads with the likeliest vulnerability in the
repository rather than with whichever method is heaviest overall. Each row also
reorders to lead with the match, so a row selected for a vulnerability does not
print `refactor` in its Type column.

A filter reads the listed issues, so it inherits the floor: `type=security` is
the methods probably carrying a vulnerability, not every method that scored
nonzero on one. `--min 80` narrows it further; `--min 0` widens it to everything
the scan answered.
