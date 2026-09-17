# How a fix works

`perch fix` runs one agent per method. The generating model writes the rewrite;
the scan itself, run again over that rewrite, decides whether it is better.
Perch trusts the tool results it recorded, never what the model says about them.

## The contract

Every issue the scan raised about the method is an objective, and each has a
statement of what must be true afterwards:

| Issue | What the rescan has to find |
| --- | --- |
| defect | the scan no longer sees it |
| security | the hole closed — validated, escaped, parameterised, confined or bounded — without changing what a legitimate caller gets |
| refactor | the structural change actually done: split, flatten, simplify, dedupe, rename, delete |
| misdocumented | a comment stating the contract, the edge cases, the side effects |
| misaligned | a name and comment that say what the code does |

A method that changed since the scan, or one the metrics flagged that System One
never read, is read again first, so the objectives come from the method as it
reads now. So is one whose answers predate the current question set — otherwise
every rewrite looks like it introduced a problem that was always there and
simply had no question.

## The prompt

Everything the scan knew: every answer with its probability, the flagged line
and how sure, the severity distribution, which calls and callers look wrong, the
file's metrics, and the neighbourhood — imports, module scope, the callees'
source, the callers' source around each call site, the call graph.

Lines `start`–`end` of the file are what the model replaces: the comment above
the method, the method, and any sibling helpers it needs in that range. The
method's name and signature have to survive so its callers keep working.

## The tools

They are the model's to use in any order and as often as it needs; perch does
not drive it through a fixed sequence. Several may be called in one turn and run
in the order given, so one attempt need not cost several reasoning passes.

**`read(path)`** — any file tracked at the revision, with line numbers, or a
directory listing. The prompt carries the neighbourhood, not the repository, so
this is how the model checks a caller it must keep working, a callee's real
contract, or a test that covers the method.

**`measure(source)`** — splice the rewrite over the region and run tree-sitter.
It must parse and still contain a method of that name. Sibling helpers in the
region are fine. It returns the method and file metrics; whether the issues
cleared is rescan's business, not this one's.

The only thing `measure` refuses is a file that grew too much: 25 lines or 10%,
whichever is larger, and complexity by 2 or 5%. Extracting a helper costs a few
signatures and returns and that is honest; a rewrite that inflates the file has
moved the mess rather than removed it.

**When a vulnerability is among the objectives there is no complexity ceiling.**
Closing a hole means validating, bounding or escaping something, and every one
of those is a branch. Refusing a security fix to hold a complexity number is the
wrong trade. The line budget still applies.

**`rescan(source)`** — the same scan over the rewrite: the same System One
questions with the same neighbourhood, plus the metrics. At most 12 per fix.

**`run_tests(source)`** — every test that reaches the method, or the project's
suite when none does, run against the rewrite. A test that fails on the rewrite
is run once on the original, and one that already failed there is ignored rather
than blamed. At most 6 runs.

**`submit(source, summary, notes)`** — refused unless `measure`, `rescan` and
`run_tests` have all passed that exact source. The summary is the commit line,
under 72 characters, imperative. The notes are two or three sentences of plain
technical English for the reviewer: what was wrong, what changed, what is better
now. Bullets are refused, so are marketing words and openings like "This
change".

## The test: Pareto, not a threshold

`rescan` adds up how many problems each reading expects, counting every answer at
the probability the model gave it, with correctness and design kept apart —
the same arithmetic the ranking uses, in [scan.md](scan.md).

```
accept  ⟺  neither total rose  ∧  at least one fell
```

Neither kind may go up and one must come down. A rewrite does not get to buy
correctness with shape, or shape with bugs.

There is no threshold to clear. Halving a defect's probability counts for
exactly that. An issue the scan names for the first time counts against the
rewrite only as much as it is believed — a new issue at 12% costs 0.12, not a
veto. A rewrite that moves neither total is rejected for changing nothing the
scan can see.

The objectives and the test read different lists on purpose. The objectives are
the issues above [the floor](scan.md#the-floor): the model is not asked to chase
a 15% maybe. The test counts everything, floor or no floor, so a rewrite gets
credit for pushing a 40% defect down to 10% and is charged for pushing a 10% one
up to 40%, neither of which either list ever shows.

This replaced a set of hand-picked pass marks: an issue had to drop below 50%,
the file's risk score could not rise by more than five points, a 1% improvement
did not count. Every one of those numbers was invented, and the risk cap alone
blocked real splits — extracting a three-line helper raises a small file's risk
from 26.47 to 30.2.

## Commit and record

The file is committed on the current branch with the summary as the message and
`perch <issue-id>` in the body. The diff goes to `<out>/fixes/<fix-id>/fix.patch`,
the full trace of every tool call and result to `fix.json`, and a `fixed` event
with the commit, the notes and the issues before and after to `events.jsonl`.

What gets printed is that record — what was cleared, what is still there and by
how much, what the rewrite introduced, the metrics that actually moved, the
tests that passed, and the cost.

A rejected run leaves the checkout exactly as it was. A method already worked by
the same model is not retried until it changes.

## When a run ends

* 40 turns is the backstop.
* A run whose rescans or test runs are spent with nothing passing ends there,
  rather than turning over with no way left to finish.
* Three refused submits is a model looping rather than working.
* Reasoning effort is `medium` by default and held constant through the run,
  since the prompt cache is keyed on it.
* If the checkout changes underneath a run, the run aborts — and so does the
  rest of the batch, since the same will be true of every finding after it.

## Finding the tests

How the project runs its tests is discovered from the tree at `HEAD`: candidate
commands from `package.json` and its lockfile, `pyproject.toml`, `Cargo.toml`,
`go.mod`, `Makefile`, `justfile`, and `run:` lines in GitHub workflows. When
there is more than one candidate, System One picks; the choice is cached under
`<out>/projects/<commit>.json`.

Commands run in your checkout with your installed dependencies, each in its own
process group with a timeout and bounded output. `perch scan` runs none of this.
