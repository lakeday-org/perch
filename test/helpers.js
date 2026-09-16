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

/** The fixture's existing test file for clamp. */
export const existingTestSource = `import assert from 'node:assert/strict';
import test from 'node:test';
import { clamp } from '../src/clamp.js';

test('clamp enforces the lower bound', () => {
  assert.strictEqual(clamp(-1, 0, 10), 0);
  assert.strictEqual(clamp(5, 0, 10), 5);
});
`;

const author = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com'];

/** A fresh repository on `main` with a committed tree, then checked out on a feature branch, since fix and refactor commit to the current branch. */
async function initRepo(root) {
  await git(['init', '-q', '-b', 'main', '.'], root);
  await git(['config', 'user.name', 'Fixture'], root);
  await git(['config', 'user.email', 'fixture@example.com'], root);
  await git([...author, 'add', '-A'], root);
  await git([...author, 'commit', '-q', '-m', 'fixture'], root);
  await git(['checkout', '-q', '-b', 'work'], root);
}

/** A git repository with a planted bug in src/clamp.js and a passing existing test. */
export async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'perch-fixture-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  await writeFile(join(root, 'src', 'clamp.js'), buggySource);
  await writeFile(join(root, 'test', 'clamp.test.js'), existingTestSource);
  await initRepo(root);
  return root;
}

/** The corrected clamp method alone, as the fix contract asks for it. */
export const fixedMethod = fixedSource.trimEnd();

/** A rewrite of clamp that documents it and keeps its behavior, bug included; same metrics as the original. */
export const documentedSource = `/** Clamp v into [lo, hi]: values below lo become lo, values above hi become hi. */\n${buggySource.trimEnd()}`;
/** A rewrite that drops the branch which returns v unchanged: identical behavior, one branch less. */
export const leanerSource = `/** Clamp v to at least lo; values above hi pass through unchanged. */
export function clamp(v, lo, hi) {
  if (v < lo) return lo;
  return v;
}`;

export const defaultResponses = {
  fix: () => ({ source: fixedMethod, summary: 'Return hi when v exceeds the upper bound.',
    notes: 'The upper bound was returned as the caller\'s own value, so clamp(11, 0, 10) gave back 11 instead of 10. The branch now returns hi. Callers that rely on the result staying inside the range get that again.' }),
};

/**
 * A scripted agent standing in for the generating model. `overrides.fix` returns proposals by attempt id (fix-1, fix-2, ...); the agent
 * runs the verifiers on each in the order a careful model would (measure, rescan, run_tests, submit), submits the first that passes
 * them all, and gives up after three proposals. Every tool call it makes is recorded in `calls`.
 */
export function scriptedModel(overrides = {}) {
  const calls = [];
  const responses = { ...defaultResponses, ...overrides };
  return {
    id: 'scripted-model', effort: null, calls,
    async run({ prompt, tools, onEvent = () => {} }) {
      const byName = new Map(tools.map(item => [item.name, item]));
      const trace = [];
      let turns = 0, done = false;
      const call = async (name, args) => {
        calls.push({ id: `fix-${turns}`, prompt, name, arguments: args });
        const event = { at: new Date().toISOString(), type: 'tool_call', turn: turns, name, arguments: args };
        trace.push(event); onEvent(event);
        const result = await byName.get(name).handler(args);
        const after = { at: new Date().toISOString(), type: 'tool_result', turn: turns, name, result };
        trace.push(after); onEvent(after);
        return result;
      };
      for (let attempt = 1; attempt <= 3 && !done; attempt++) {
        turns++;
        const proposal = responses.fix(`fix-${attempt}`, prompt);
        for (const name of ['measure', 'rescan', 'run_tests', 'submit']) {
          const result = await call(name, name === 'submit' ? { source: proposal.source, summary: proposal.summary, notes: proposal.notes } : { source: proposal.source });
          if (!result.ok) break;
          if (result.done) { done = true; break; }
        }
      }
      return { done, turns, usage: { input_tokens: 1000 * turns, cached_tokens: 900 * (turns - 1), output_tokens: 200 * turns, reasoning_tokens: 0 }, trace };
    },
  };
}

export const fixtureOptions = (repo, extra = {}) => ({ root: repo.root, revision: repo.revision, out: repo.out, paths: [], ...extra });

/** A git repository with two source files whose methods call each other across an import, plus a test file. */
export async function makeGraphFixture() {
  const root = await mkdtemp(join(tmpdir(), 'perch-graph-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'graph', version: '1.0.0', type: 'module' }, null, 2) + '\n');
  await writeFile(join(root, 'src', 'a.js'), `import { h } from './b.js';

export function f(x) {
  if (x > 10) return g(x) + h(x);
  if (x < 0) return h(-x);
  return g(x);
}

function g(x) {
  if (x > 1) return x;
  return 0;
}
`);
  await writeFile(join(root, 'src', 'b.js'), `export function h(x) {
  return k(x) * 2;
}

export function k(x) {
  return x - 1;
}
`);
  await writeFile(join(root, 'test', 'a.test.js'), `import test from 'node:test';
import { f } from '../src/a.js';

test('f', () => { f(1); });
`);
  await initRepo(root);
  return root;
}

export async function commitAll(root, message) {
  await git([...author, 'add', '-A'], root);
  await git([...author, 'commit', '-q', '-m', message], root);
}

/** Questions whose plausible default answer is "yes". */
const affirmative = new Set(['does_what_it_claims', 'imports_real_method', 'targets_defect', 'reachable_by_callers', 'asserts_behavior', 'reachable']);

/**
 * A scripted System One: answers every question plausibly, with overrides keyed by what the state is about.
 * A hunt or patch-check state is keyed by method id (`src/a.js::f`), a test check by `test`, a project discovery by `project`.
 */
export function scriptedSystemOne(overrides = {}) {
  const calls = [];
  const keyOf = state => (state.test ? 'test' : state.method ? `${state.method.path}::${state.method.name}` : 'project');
  return {
    id: 'scripted-jev',
    calls,
    async ask(state, questions) {
      const key = keyOf(state);
      const own = overrides[key] ?? {};
      calls.push({ method: key, state, questions });
      const answers = {};
      for (const [id, question] of Object.entries(questions)) {
        if (question.type === 'noul') answers[id] = { type: 'noul', noul: own[id] ?? (affirmative.has(id) ? 0.9 : 0.2) };
        else if (question.type === 'score') answers[id] = { type: 'score', score: own[id] ?? 1, confidence: 0.6, legend: {}, probabilities: {} };
        else {
          const keys = Object.keys(question.criteria);
          const choice = own[id] && keys.includes(own[id]) ? own[id] : keys.at(-1);
          answers[id] = { type: 'choice', choice, confidence: 0.8, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 0.8 : 0.2 / Math.max(1, keys.length - 1)])) };
        }
      }
      return { model: 'scripted-jev', answers, usage: { input_tokens: 100, output_tokens: 10 } };
    },
  };
}
