# Perch on ReviewBench

A fixed two-reading bug detector, evaluated with Jev and GPT-6 Luna Decisions on the same code, questions and labels.

## Results

**16,168 methods across 177 pull requests, including 1,506 labelled buggy methods.**

| Model | Precision | Recall | F1 | Correct alerts | False alerts | Missed bugs | Inference cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| Jev 1.14 | 34.7% | 20.2% | 25.5% | 304 | 572 | 1,202 | $2.9283 |
| GPT-6 Luna Decisions | 21.7% | 81.1% | 34.2% | 1,221 | 4,414 | 285 | $5.6363 |

## Two readings

1. **Current code and its change.** Complete target source, a window of previous source, overlapping diff hunks and the PR title. Questions ask whether the current target has a functional bug, a supported edge-case failure or an exploitable security issue.
2. **Caller and callee contracts.** Target source plus selected caller, callee, type and configuration evidence. Questions check accepted caller inputs, return contracts, failure cleanup and access scope. Source structure selects applicable checks; the first answer does not gate this reading.

Both models use this protocol. Every target gets the current-code reading; 14,768 also have applicable contract checks, for **30,936 readings per model**. Large inputs use bounded chunks within a reading. Alerts from either reading count once per target. Jev had no failed readings; Luna had one affecting one method. That failure is included in the scores.

## Data and scoring

[ReviewBench](https://github.com/review-bench/ReviewBench) supplies PRs and reference findings. `manifest.json` pins the ReviewBench and Perch revisions. `targets.jsonl` records each repository, base/head commits, file, method span, repository split and labels. All 219 PRs were checked for method targets: 177 contributed methods and 42 had none. `coverage.jsonl` records the method counts for each PR and source file. The benchmark scores methods; caller/callee implementations, configuration and diffs supply context.

The frozen requests contain code and context. Reference findings and judgments stay outside inference. Truncated evidence is marked explicitly.

- Functional alerts require probability **strictly above 60%**; security alerts require **strictly above 70%**.
- A reference bug must overlap its target. Additional positives require a faulty operation inside that target and source evidence at the recorded head commit. A correct caller of a defective helper is not another positive.
- Both models use the same 1,506 positive and 14,662 negative methods. `judgments.jsonl` retains source-backed reviews of additional alerts.
- A refusal or timeout counts as a miss on a buggy target and a false alert on a clean one. Missing requests make a run incomplete.
- Precision is correct alerts divided by all alerts. Recall is bugs detected divided by labelled buggy targets. F1 is their harmonic mean.

These are method detection results. ReviewBench's official leaderboard judges review comments against individual issues across its full corpus.

## Reproduce

From the repository root, with Node.js 22 or newer:

```sh
npm ci
node .benchmarks/reviewbench/score.mjs
npx vitest run --config .benchmarks/reviewbench/vitest.config.mjs
```

Scoring makes no API calls. It reads frozen requests and saved probabilities, applies the fixed thresholds and writes `summary.json`. Both inference and scoring reject whole-file targets. `manifest.json` records SHA-256 hashes of the compressed JSONL snapshots.

To repeat inference, set `TYPESAFE_API_KEY` or `OPENAI_API_KEY` in your environment:

```sh
node .benchmarks/reviewbench/run.mjs --provider jev
node .benchmarks/reviewbench/run.mjs --provider luna
node .benchmarks/reviewbench/score.mjs --results .benchmarks/reviewbench/runs/live
```

Use `--limit 2 --out /tmp/perch-reviewbench-smoke` for a small smoke test. Partial runs cannot produce a complete score. Responses are cached by input identity and model, including refusals. Resume with the same directory. An interrupted run retains completed responses and resumes unfinished readings. Requests time out after 30 seconds; authentication, balance and model-version errors stop the run. Other rejected requests are recorded as failures and the run continues.

Jev's preview alias must return `jev-1.14.0`. If it changes, select a new output directory and pass the observed version with `--expected-model`. Luna uses two-option choices, unchanged instructions and the probability attached to the true option. There is no third option. Refusals retain their question names.

Costs use returned input usage at Jev $0.042 and Luna $0.10 per million tokens. These estimates sum the saved method requests. Provider information: [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions).

## Verify judgments

For an added positive, record the faulty line inside the target, an accepted input or operation that fails, and the relevant source quotation. Intentional behavior and defects confined to another target are unsupported for this target. Uncertain cases remain explicit for review.

Verify the stored quotations at their pinned commits:

```sh
node .benchmarks/reviewbench/judge.mjs --repos .benchmarks/reviewbench/repos --fetch
```

`--judgments path/to/judgments.jsonl` validates an edited judgment file. This checks target-local anchors and exact source quotations without a judging API. Source licenses remain with their linked repositories; ReviewBench is [MIT licensed](https://github.com/review-bench/ReviewBench/blob/main/LICENSE).
