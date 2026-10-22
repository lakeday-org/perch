# Perch on ReviewBench

[ReviewBench](https://github.com/review-bench/ReviewBench) is a benchmark created by GitHub, containing a set of 219 PRs, each with a list of reference findings from a human code review. This directory contains a run of perch on this dataset. In short, perch asks a set of bug-related questions about every method each PR changed, and scores two models (Jev 1.14 and GPT-6 Luna Decisions) based on their answers, as compared to the list of findings from ReviewBench.

The requests, answers, labels, and scoring scripts are all stored in this directory, so you can rerun the scoring or verify any part of it if you like. Scoring needs no API key.

## Results

In total, perch asked questions about 16,168 methods in 177 PRs, of which 1,506 were labelled as buggy.

| Model | Precision | Recall | F1 | Correct alerts | False alerts | Missed bugs | Inference cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| Jev 1.14 | 34.7% | 20.2% | 25.5% | 304 | 572 | 1,202 | $2.9283 |
| GPT-6 Luna Decisions | 21.7% | 81.1% | 34.2% | 1,221 | 4,414 | 285 | $5.6363 |

Of the 876 alerts that Jev raised, about a third were correct. It missed 4/5 of the bugs. Luna detected 4/5 of the bugs, but produced over 3 false alerts per correct alert.

## How this differs from the leaderboard

The ReviewBench leaderboard works by asking each reviewer to review each PR, then asking a judge model to compare each review comment to the reference findings, and determining whether the comment matches any findings. Perch does not produce any review comments here. Instead, it asks a set of specific yes/no questions about each method, and the scores are per method. A method is considered buggy if any finding is present within the method. A method is considered to be flagged if any question about that method is above a fixed threshold.

Of the 219 PRs in ReviewBench, perch read methods in 177 of them, since the other 42 changed none that perch can score. For details on all 219 PRs and how many methods were extracted from each file in each PR, see `coverage.jsonl`.

## Two readings per method

Each method was read twice, and both models were asked the same set of questions:

1. The method was read in the context of the change: its current source code, a window of its source code from before the change, the diff hunks affecting the method, and the PR title. It was asked whether the method contains a functional bug, whether it mishandles empty or boundary values, and whether it has any security issues that could be exploited by an attacker.
2. The method was read in the context of its callers and callees: its source code, along with a selection of its callers, callees, relevant type definitions, and configuration. It was asked whether a caller could provide a valid input that the method fails to handle correctly, whether the method could return a value that is not handled correctly by its callers, whether the method could fail to perform necessary cleanup operations in the case of a failure, and whether the method could allow a caller to bypass tenant or permission checks. Only the relevant questions were asked, based on the content of the method, regardless of the answers to the first reading.

All methods were read in context of the change. Additionally, 14,768 methods were read in context of their callers and callees, for a total of 30,936 readings per model. Each reading had a maximum input size, but readings could be split into multiple requests if the input exceeded this size. Jev had no failed readings. Luna had one failed reading for one method, which is included in the scores.

## Labels and scoring

Information about each method, including its repository, base and head commits, file, line numbers, its ReviewBench split, and its labels, can be found in `targets.jsonl`. Information about the exact revisions of ReviewBench and perch used, as well as SHA-256 hashes for every snapshot, can be found in `manifest.json`.

Methods were considered to be buggy if they overlapped with a reference finding from ReviewBench.

Additionally, each alert that was not labelled by ReviewBench was checked to determine if the method should be considered buggy. If the fault was on a line of code contained within the method, and a quote of the source code at the head of the PR showed it, the method was considered to be buggy. Alerts describing intended behavior or methods that called a broken helper method correctly were not considered to be bugs. These judgments are stored in `judgments.jsonl`, and consisted of 638 supported alerts, 4,806 unsupported alerts, and 11 that were uncertain.

Both models were scored against the same set of 1,506 buggy methods and 14,662 clean methods.

The threshold for functional questions was 60% (exactly 60% was not considered a flag), and for security questions it was 70% (again, exactly 70% was not a flag).

If a reading failed (due to refusal or timeout), it was scored as a miss if the method was buggy, or as a false alert if it was not. If a reading was missing, the run was considered to be incomplete, and not scored at all.

Precision was the ratio of correct alerts to all alerts, recall was the ratio of flagged bugs to all buggy methods, and F1 was the harmonic mean of these two.

Note that only code and context are provided to the models, never labels or judgments. Evidence that had to be cut short is marked as truncated.

## Reproduce

To reproduce the benchmark from this repository with Node.js 22+:

```sh
npm ci
node .benchmarks/reviewbench/score.mjs
npx vitest run --config .benchmarks/reviewbench/vitest.config.mjs
```

`score.mjs` will check the saved requests and answers against the hashes in `manifest.json`, score them according to the thresholds, write `summary.json` and print a table. It will not make API requests. As with `run.mjs`, it will not accept a file (as opposed to a method) as a target.

`node .benchmarks/reviewbench/chart.mjs` redraws the recall chart in the main README from `summary.json` and the leaderboard rows it records.

Set the `TYPESAFE_API_KEY` and/or `OPENAI_API_KEY` env variables to request answers from Jev and/or Luna:

```sh
node .benchmarks/reviewbench/run.mjs --provider jev
node .benchmarks/reviewbench/run.mjs --provider luna
node .benchmarks/reviewbench/score.mjs --results .benchmarks/reviewbench/runs/live
```

Pass `--limit 2 --out /tmp/perch-reviewbench-smoke` for a smoke test. Partial runs cannot be scored. Answers are cached by input and model, even if the model refuses to answer. Re-running with the same `--out` will resume the run, reading already-completed requests from disk and re-requesting incomplete ones. Requests to either model will time out after 30 seconds. If your API key has been refused, has no balance, or the model version has changed, the run stops; any other rejected request is recorded and the run will continue.

Jev's preview alias must respond as `jev-1.14.0`. If it doesn't, use a new output directory and pass the new model name with `--expected-model`. When asking Luna, each question is sent as a choice between true and false without changing its criteria. Luna's score for each question is its probability for true.

Costs are tabulated based on input tokens reported by each provider, at $0.042 and $0.10 per million tokens for Jev and Luna respectively. See Typesafe's [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) and OpenAI's [Decisions](https://developers.openai.com/api/docs/guides/decisions) for more.

## Verify the judgments

For each supported judgment in the unlabelled alerts, the faulty method line, faulty input or operation, and quoted source are provided. To verify the quoted sources at their pinned commits:

```sh
node .benchmarks/reviewbench/judge.mjs --repos .benchmarks/reviewbench/repos --fetch
```

Pass `--fetch` to fetch those commits into separate repos in the directory specified by `--repos`. Omit `--fetch` to verify using already-fetched repos. Pass `--judgments path/to/judgments.jsonl` to check a file you've edited. Checking them uses no model.

Source code is licensed according to its respective repository. ReviewBench is [MIT-licensed](https://github.com/review-bench/ReviewBench/blob/main/LICENSE).
