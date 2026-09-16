import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git.js';

export const buggySource = `export function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return v;
  return v;
}
`;

export const fixedSource = `export function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
`;

export const regressionSource = `import assert from 'node:assert/strict';
import test from 'node:test';
import { clamp } from '../src/clamp.js';

test('clamp enforces the upper bound', () => {
  assert.strictEqual(clamp(11, 0, 10), 10);
});
`;

const author = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com'];

/** A git repository with a planted bug in src/clamp.js and a passing existing test. */
export async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'perch-fixture-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  await writeFile(join(root, 'src', 'clamp.js'), buggySource);
  await writeFile(join(root, 'test', 'clamp.test.js'), `import assert from 'node:assert/strict';
import test from 'node:test';
import { clamp } from '../src/clamp.js';

test('clamp enforces the lower bound', () => {
  assert.strictEqual(clamp(-1, 0, 10), 0);
  assert.strictEqual(clamp(5, 0, 10), 5);
});
`);
  await git(['init', '-q', '-b', 'main', '.'], root);
  await git([...author, 'add', '-A'], root);
  await git([...author, 'commit', '-q', '-m', 'fixture'], root);
  return root;
}

export const defaultResponses = {
  preparation: () => ({ setup: 'true', baseline: 'npm test' }),
  triage: () => ({ found: true, title: 'clamp ignores the upper bound', reason: 'clamp returns v instead of hi when v exceeds hi.', priority: 'P2',
    regression_path: 'test/clamp.regression.test.js', regression: regressionSource, command: 'node --test test/clamp.regression.test.js' }),
  fix: () => ({ source: fixedSource, summary: 'Return hi when v exceeds the upper bound.' }),
  review: () => ({ approved: true, reason: 'The regression reproduces the bug and the fix is narrow.' }),
};

/** A scripted model: responses are chosen by the inference id prefix. */
export function scriptedModel(overrides = {}) {
  const calls = [];
  const responses = { ...defaultResponses, ...overrides };
  return { id: 'scripted-model', calls, async ask(id, prompt) { calls.push({ id, prompt }); return responses[id.split('-')[0]](id, prompt); } };
}

/** Counts executions while delegating to the real shell. */
export function countingShell(real) {
  const shell = { calls: [], run(script, options) { shell.calls.push(script); return real.run(script, options); } };
  return shell;
}
