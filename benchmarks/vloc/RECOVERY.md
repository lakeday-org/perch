# Resuming a VLoc benchmark

The recovery runner uses an existing benchmark worktree and its original built CLI. It preserves the experiment fingerprint and records the recovery controller's hash separately.

Run `python3 -B benchmarks/vloc/safe_resume.py --baseline /path/to/benchmark-worktree --name experiment-name` with the API key exported. The baseline worktree must contain the VLoc harness, verified snapshots, and an existing experiment.

Completed snapshots are retained. Identical repository snapshots share scan output and are scored against each case's own expected files. Interrupted scans seed Perch's normal cache from saved successful readings; Perch reuses a reading only when its request key still matches.

New model responses are cached by the exact endpoint and request body. Concurrent identical requests share one response. An uncertain network outcome stops the run for review instead of automatically sending again. HTTP 401, 402, or 403 stops the entire cohort. An exclusive lock prevents another recovery runner from starting while the runner or its scanner children remain alive.

The transport cache retains successful responses, a network usage ledger, and cache-hit records. Cached responses contribute zero new token usage. Previously interrupted attempts remain separate evidence and must be included in total spend. Perch's request counter includes logical cache lookups; the network ledger counts actual requests.

New estimated spend is limited to $90 by default, using Perch's configured Jev rate. Already in-flight requests may finish when the limit is reached. `--budget-usd` sets the initial limit; restarting does not reset it. Other account activity is outside this budget. A `STOP.json` file requires review before any restart.
