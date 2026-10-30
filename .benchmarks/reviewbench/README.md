# Perch on ReviewBench

[ReviewBench](https://github.com/review-bench/ReviewBench) is a benchmark created by GitHub, containing a set of 219 PRs, each with a list of reference findings from a human code review. Here are two runs of perch on this dataset, both scored per method against the same labels. In short, perch asks bug-related questions about the methods each PR changed, and a method counts as flagged when an answer is above a cutoff.

The frozen run asked up to seven questions in two readings of each method, on Jev 1.14 and GPT-6 Luna Decisions. The [rerun](#the-rerun) is `perch scan --since` from perch#418, which asks two, on GPT-6 Luna and, with the released 0.4.8, on Jev. The scoring scripts are in this directory. The requests, answers and labels are on [Hugging Face](#data). Scoring needs no API key.

## Frozen run

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

In the frozen run, each method was read twice, and both models were asked the same set of questions:

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

## The rerun

The frozen run replays requests in perch#407's two-reading format, which perch no longer sends. The rerun is what perch does now. It ran `perch scan --since <base> --include-tests` from perch#418 on GPT-6 Luna Decisions, over 171 of the 177 PRs. The other six could not be checked out, because their repository or base commit no longer exists. Tests are read because ReviewBench's targets include test methods.

Each PR's answers are in `results/rerun-luna.jsonl.gz`. A target is matched to the method perch read in the same file whose lines overlap it most, and a target perch did not read counts as not flagged. A method is flagged when `has_bug` or `bug_edge_case` is above the cutoff. All 1,506 labels count, as in the frozen run.

| Cutoff | Precision | Recall | F1 | Flag rate | Correct alerts | False alerts | Missed bugs |
|---|---:|---:|---:|---:|---:|---:|---:|
| 60% | 28.8% | 40.0% | 33.5% | 13.0% | 603 | 1,491 | 903 |
| 70% | 35.2% | 31.9% | 33.4% | 8.4% | 480 | 884 | 1,026 |
| 80% | 41.7% | 23.2% | 29.8% | 5.2% | 349 | 487 | 1,157 |

60% is perch's floor for both questions on every model. By split:

| Split | Cutoff | Precision | Recall | F1 | Flag rate | Correct alerts | False alerts | Missed bugs |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Development | 60% | 29.2% | 48.2% | 36.4% | 15.1% | 455 | 1,103 | 489 |
| Development | 70% | 36.2% | 38.7% | 37.4% | 9.8% | 365 | 642 | 579 |
| Development | 80% | 44.0% | 28.5% | 34.6% | 5.9% | 269 | 342 | 675 |
| Validation | 60% | 27.6% | 26.3% | 27.0% | 9.2% | 148 | 388 | 414 |
| Validation | 70% | 32.2% | 20.5% | 25.0% | 6.1% | 115 | 242 | 447 |
| Validation | 80% | 35.6% | 14.2% | 20.3% | 3.9% | 80 | 145 | 482 |

The rerun's recall is lower than the frozen run's for three reasons:

1. `perch scan --since` asks only about methods the diff changed. 292 labelled bugs sit in targets the diff left untouched, so the rerun never read them. One more is in a file perch does not parse, and 80 are in the six PRs that could not be checked out.
2. It asks two questions of each method, where the frozen run asked up to seven.
3. 645 of the 1,506 labels came from judging the frozen run's own alerts, so they favour it.

Against the 861 labels from ReviewBench's reference findings alone:

| Run | Precision | Recall | F1 | Correct alerts | False alerts | Missed bugs |
|---|---:|---:|---:|---:|---:|---:|
| Rerun at 60% | 20.2% | 49.0% | 28.6% | 422 | 1,672 | 439 |
| Rerun at 70% | 25.0% | 39.6% | 30.7% | 341 | 1,023 | 520 |
| Rerun at 80% | 30.0% | 29.2% | 29.6% | 251 | 585 | 610 |
| Frozen run, Jev 1.14 | 17.8% | 18.1% | 18.0% | 156 | 720 | 705 |
| Frozen run, GPT-6 Luna Decisions | 10.6% | 69.6% | 18.4% | 599 | 5,036 | 262 |

The rerun cost $4.1569 in input tokens. The same rerun on Jev, `perch scan --since` from the released 0.4.8 on `jev-latest`, cost $1.7982 over the same 171 PRs. At 60% it finds 7.9% of the labelled bugs at 45.8% precision; its answers are in `results/rerun-jev.jsonl.gz` and its scores in `rerun-jev-summary.json`, written by `rerun-score.mjs --results <data>/results/rerun-jev.jsonl.gz --summary <data>/rerun-jev-summary.json`.

## Data

The data is in the [perchscan/benchmark-results](https://huggingface.co/datasets/perchscan/benchmark-results) dataset on Hugging Face, in its `reviewbench` folder. Download it from the root of this repository:

```sh
pip install -U huggingface_hub
hf download perchscan/benchmark-results --repo-type dataset --include 'reviewbench/*' --local-dir .benchmarks/hf
```

The files land in `.benchmarks/hf/reviewbench/`, which git ignores, and the scripts read them there. Without them, a script that reads them prints this command and exits 2, and the test that reads `targets.jsonl` is skipped.

## Reproduce

To reproduce the benchmark with Node.js 22+, [download the data](#data), then run from the root of this repository:

```sh
npm ci
node .benchmarks/reviewbench/score.mjs
npx vitest run --config .benchmarks/reviewbench/vitest.config.mjs
```

`score.mjs` will check the saved requests and answers against the hashes in `manifest.json`, score them according to the thresholds, write `summary.json` beside them and print a table. It will not make API requests. As with `run.mjs`, it will not accept a file (as opposed to a method) as a target.

To score the rerun from its saved answers:

```sh
node .benchmarks/reviewbench/rerun-score.mjs
```

`rerun-score.mjs` prints the tables above and writes `rerun-summary.json` beside the data. `node .benchmarks/reviewbench/chart.mjs` redraws the recall chart in the main README from `rerun-summary.json` and the leaderboard rows it records.

Set the `TYPESAFE_API_KEY` and/or `OPENAI_API_KEY` env variables to request answers from Jev and/or Luna:

```sh
node .benchmarks/reviewbench/run.mjs --provider jev
node .benchmarks/reviewbench/run.mjs --provider luna
node .benchmarks/reviewbench/score.mjs --results .benchmarks/reviewbench/runs/live
```

Pass `--limit 2 --out /tmp/perch-reviewbench-smoke` for a smoke test. Partial runs cannot be scored. Answers are cached by input and model, even if the model refuses to answer. Re-running with the same `--out` will resume the run, reading already-completed requests from disk and re-requesting incomplete ones. Requests to either model will time out after 30 seconds. If your API key has been refused, has no balance, or the model version has changed, the run stops; any other rejected request is recorded and the run will continue.

To rerun the rerun, build perch and set `PERCH_BASE_URL` and the key for it, as for any `perch scan`. `rerun.mjs` scans each PR with this checkout's `bin/perch.mjs` and writes one line a PR to `runs/rerun.jsonl`. A finished PR is not scanned again, so running it again resumes.

```sh
npm run build
PERCH_BASE_URL=https://api.openai.com/v1/decisions node .benchmarks/reviewbench/rerun.mjs --parallel 6
node .benchmarks/reviewbench/rerun-score.mjs --results .benchmarks/reviewbench/runs/rerun.jsonl --summary /tmp/rerun-summary.json
```

Jev's preview alias must respond as `jev-1.14.0`. If it doesn't, use a new output directory and pass the new model name with `--expected-model`. When asking Luna, each question is sent as a choice between true and false without changing its criteria. Luna's score for each question is its probability for true.

Costs are tabulated based on input tokens reported by each provider, at $0.042 and $0.10 per million tokens for Jev and Luna respectively. See Typesafe's [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) and OpenAI's [Decisions](https://developers.openai.com/api/docs/guides/decisions) for more.

## Verify the judgments

For each supported judgment in the unlabelled alerts, the faulty method line, faulty input or operation, and quoted source are provided. To verify the quoted sources at their pinned commits:

```sh
node .benchmarks/reviewbench/judge.mjs --repos .benchmarks/reviewbench/repos --fetch
```

Pass `--fetch` to fetch those commits into separate repos in the directory specified by `--repos`. Omit `--fetch` to verify using already-fetched repos. Pass `--judgments path/to/judgments.jsonl` to check a file you've edited. Checking them uses no model.

Source code is licensed according to its respective repository. ReviewBench is [MIT-licensed](https://github.com/review-bench/ReviewBench/blob/main/LICENSE).
