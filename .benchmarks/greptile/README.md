# Perch on the Greptile benchmark

[Greptile's benchmark](https://www.greptile.com/benchmarks) runs AI code reviewers on 50 pull requests, ten from each of Sentry, Cal.com, Grafana, Keycloak and Discourse. Each pull request sits in a fork under [ai-code-review-evaluation](https://github.com/ai-code-review-evaluation), such as [sentry-greptile](https://github.com/ai-code-review-evaluation/sentry-greptile), and carries a known bug. [Martian's code review benchmark](https://github.com/withmartian/code-review-benchmark) lists golden comments for the same pull requests: 173 comments a reviewer should leave, most of them bugs.

This directory holds the scripts that score four perch runs on those pull requests. The runs and the labels they are scored against are on [Hugging Face](#data). Scoring needs no API key.

## Results

Greptile graded each tool on the one known bug in each pull request. Graded the same way, perch#418 on OpenAI's Decisions model catches 38 of the 50 at perch's 60% floor, with a median of 7 functions flagged in each.

| Configuration | Cutoff | Known bugs caught | By chance | PRs with a golden bug caught | Golden comments caught | Flags | Median flags a PR | Model cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| perch#418, OpenAI Decisions | 60% | 38 (76%) | 20.2 | 42 | 116 | 490 | 7 | $0.335 |
| perch#418, OpenAI Decisions | 70% | 33 (66%) | 16.3 | 39 | 105 | 383 | 6 | $0.335 |
| perch#418, OpenAI Decisions | 80% | 28 (56%) | 11.8 | 39 | 86 | 264 | 4 | $0.335 |
| perch#407, OpenAI Decisions | 60% | 39 (78%) | 16.8 | 44 | 122 | 918 | 14 | $0.640 |
| perch#407, OpenAI Decisions | 70% | 36 (72%) | 13.1 | 42 | 110 | 684 | 10 | $0.640 |
| perch#407, OpenAI Decisions | 80% | 33 (66%) | 9.4 | 40 | 98 | 472 | 6 | $0.640 |
| perch 0.4.7, Jev | 60% | 18 (36%) | 6.1 | 27 | 61 | 418 | 4 | $0.760 |
| perch 0.4.7, Jev | 70% | 10 (20%) | 3.2 | 17 | 40 | 176 | 1 | $0.760 |
| perch 0.4.7, Jev | 80% | 4 (8%) | 1.0 | 7 | 13 | 50 | 0 | $0.760 |
| perch 0.4.7, OpenAI Decisions | 60% | 28 (56%) | 11.6 | 37 | 92 | 914 | 10 | $1.555 |
| perch 0.4.7, OpenAI Decisions | 70% | 24 (48%) | 10.0 | 33 | 81 | 760 | 8 | $1.555 |
| perch 0.4.7, OpenAI Decisions | 80% | 20 (40%) | 8.0 | 31 | 68 | 596 | 7 | $1.555 |

Known bugs caught are out of all 50 pull requests. In four of them the known bug sits in no function perch reads, so perch can catch at most 46. By chance is how many known bugs the same number of flags would catch if each pull request's flags fell on functions picked at random from the ones perch read there.

The last two counts use Martian's golden comments, a looser measure. A pull request counts when a flagged function holds any of its golden bugs, out of the 47 that have one in a function. Golden comments caught are out of the 140 that sit in a function. Flags are functions flagged, out of 1,568 functions read by perch#418, 4,205 by perch#407 and 4,617 by perch 0.4.7.

Greptile published these catch rates for the same 50 pull requests, as read on October 22, 2026:

| Reviewer | Caught |
|---|---:|
| Greptile | 82% |
| Cursor Bugbot | 58% |
| GitHub Copilot | 54% |
| CodeRabbit | 44% |
| Graphite | 6% |

Both are graded on the known bug. The published tools were credited for a line comment that identifies it and explains its impact. Perch is credited when it flags the function that holds it, which is a lower bar.

## Configurations

- `oai2q` is perch#418 at 6e2c92d on OpenAI's Decisions model, `gpt-6-luna`. It asks `has_bug` and `bug_edge_case` of each function the diff changed, over the function and its diff.
- `oai407` is the perch#407 build on the same model. It reads each method twice, once with the change and once with its callers and callees, and asks `review_` questions in each reading.
- `jev` and `oai` are perch 0.4.7 on Jev and on OpenAI's Decisions model, built at 97e0d74, two fixes after the release. They ask `has_bug` and `bug_edge_case` with each method's callers and callees. `jev-latest` answered as Jev 1.13 for most of the run and Jev 1.14 for part of it.

Every run is `perch scan --since <base> --json` at the pull request's head commit, which leaves tests out. The 0.4.7 and #407 builds carried the fix from perch#413, which changes how long a graph takes to build and not what is in it.

## Labels

`manifest.json` matches each of Martian's golden-comment entries to its pull request in the fork, with its base and head commits and the golden comments. `node .benchmarks/greptile/manifest.mjs` rebuilds it from GitHub and Martian's repository at a pinned commit.

`known.json` gives each pull request's known bug, in Greptile's words, and the functions that hold it, with the file, the line and a sentence saying why. Four known bugs sit outside any function perch reads.

`truth/<repo>.json` gives each golden comment the functions it is about, by pull request and comment index, with the file, the line and a sentence saying why. The labels were made from each pull request's diff, its golden comments, and the list of functions perch read, never from perch's answers. A comment about code outside any function perch reads has no function: a stylesheet, a template, a schema, a constant, or a test. 140 of the 173 golden comments sit in a function.

Three labels were made before perch read `.es6` files, so they name no function: comment 1 of discourse-2 and comments 1 and 3 of discourse-8. perch#418 reads those files, and flags `actions.next`, the subject of discourse-8's comment 1, at 92%. Those comments count as outside any function here, as they did for the older builds.

## Scoring

A function is flagged when any of its bug questions is answered above the cutoff: `has_bug` or `bug_edge_case`, or for perch#407, any `review_` question. An answer exactly at the cutoff is not a flag. A known bug is caught when a flagged function holds it. A pull request with a golden bug caught has a flagged function holding one of its golden bugs. A golden comment is caught when its function is flagged. Model cost is what perch's meter reported for the run's input tokens.

## Data

The data is in the [perchscan/benchmark-results](https://huggingface.co/datasets/perchscan/benchmark-results) dataset on Hugging Face, in its `greptile` folder. Download it from the root of this repository:

```sh
pip install -U huggingface_hub
hf download perchscan/benchmark-results --repo-type dataset --include 'greptile/*' --local-dir .benchmarks/hf
```

The files land in `.benchmarks/hf/greptile/`, which git ignores, and the scripts read them there. Without them, a script that reads them prints this command and exits 2. The tests need no data.

## Reproduce

To score the saved runs with Node.js 22+, [download the data](#data), then run from the root of this repository:

```sh
node .benchmarks/greptile/score.mjs
npx vitest run --config .benchmarks/greptile/vitest.config.mjs
```

`score.mjs` reads `results/<config>.jsonl.gz`, prints the table and writes `summary.json` beside the data. Each line in a results file is one pull request's run: its exit code, how long it took, the model's usage and cost, the methods perch reported, and every method it read with its numeric answers. `node .benchmarks/greptile/chart.mjs` draws the chart in the main README from `summary.json` and the published rows it records.

To run a configuration again, build perch and set `PERCH_BASE_URL` and the key for it, as for any `perch scan`. `run.mjs` scans each pull request with this checkout's `bin/perch.mjs` and writes `runs/<config>.jsonl`. A finished pull request is not scanned again, so running it again resumes. Pass `--repos sentry` to run one repository.

```sh
npm run build
PERCH_BASE_URL=https://api.openai.com/v1/decisions node .benchmarks/greptile/run.mjs mine
node .benchmarks/greptile/score.mjs --results .benchmarks/greptile/runs
```

A scan that uses more than 24 GB of memory is killed and recorded as failed; set `MEMORY_LIMIT_GB` to change it. A failed run counts as missing, and the table says how many.

Martian's golden comments are [MIT-licensed](https://github.com/withmartian/code-review-benchmark). Source code is licensed according to its respective repository.
