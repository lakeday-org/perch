/**
 * The test frameworks perch runs. A runner says whether it can run here, runs the whole suite once with per-test coverage, and
 * runs a set of tests against the copy as it stands. Its suite run returns `executed`, the lines each test ran by file, keyed by
 * perch's test id, and `results`, each case it ran by the runner's own id, with its test, status and time.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import * as pytest from './pytest.js';

const run = promisify(execFile);

/** The runner for the repository's test framework, by what frameworkScope found: pytest for Python tests. Null when none fits. */
export function runnerFor(scope) {
  // A framework counts the test files it runs.
  const names = new Set((scope?.frameworks ?? []).filter(framework => (Array.isArray(framework.tests) ? framework.tests.length : framework.tests ?? 0) > 0).map(framework => framework.name));
  if (names.has('pytest')) return pytest;
  return null;
}

/**
 * Copies of the repository at `revision`, one per worker, under one scratch directory: `git archive` writes the committed tree,
 * which is what the mutants are made from, so an edit in the working tree can neither break a mutant's offset nor be mutated.
 */
export async function copiesOf({ root, revision, count }) {
  // Resolved, as the tools that run in it write paths: macOS's temporary directory is a symlink, and coverage.py records the target.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'perch-mutants-')));
  const copies = [];
  for (let at = 0; at < count; at++) {
    const dir = join(scratch, `copy-${at}`);
    await mkdir(dir);
    await run('sh', ['-c', 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', 'sh', root, revision, dir], { maxBuffer: 1 << 20 });
    copies.push({ dir, scratch: await mkdtemp(join(scratch, `work-${at}-`)) });
  }
  return { scratch, copies, remove: () => rm(scratch, { recursive: true, force: true }) };
}
