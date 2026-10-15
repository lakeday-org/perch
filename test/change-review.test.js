import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { createChangeReader } from '../src/change-context.js';
import { reviewQuestions, reviewSteps } from '../src/review.js';
import { readAnswers, issuesOf } from '../src/questions.js';
import { questionMethod, scanRepository } from '../src/scan.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { commitAll, initRepo, scriptedSystemOne } from './helpers.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'perch-change-')); roots.push(root);
  await writeFile(join(root, 'a.js'), 'export function run(x) {\n  return x + 1;\n}\n');
  await initRepo(root);
  return { root, base: await revision(root) };
}
it('reads the merge base, a renamed path and new files without confusing their previous source', async () => {
  const { root, base } = await fixture();
  await git(['mv', 'a.js', 'new name.js'], root);
  await writeFile(join(root, 'new name.js'), 'export function run(x) {\n  return x - 1;\n}\n');
  await writeFile(join(root, 'added.js'), 'export function added() { return 2; }\n');
  await commitAll(root, 'change');
  const head = await revision(root);
  await git(['checkout', '-q', 'main'], root);
  await writeFile(join(root, 'a.js'), 'only on main\n'); await commitAll(root, 'main moves');
  const read = await createChangeReader(root, 'main', head);
  const changed = await read({ path: 'new name.js', line: 1, end_line: 3 });
  expect(changed.before.path).toBe('a.js');
  expect(changed.before.source).toContain('x + 1');
  expect(changed.before.source).not.toContain('only on main');
  expect(changed.diff.source).toContain('+  return x - 1;');
  expect((await read({ path: 'added.js', line: 1, end_line: 1 })).before.new_file).toBe(true);
  expect(await read({ path: 'untouched.js', line: 1, end_line: 3 })).toBeNull();
  expect(base).not.toBe(head);
});
it('selects delta checks only with a change and respects defect/security filters', () => {
  const common = { language: 'javascript', source: 'if (owner) await close(path);', callers: [{}] };
  expect(reviewQuestions(common).some(q => q.sees === 'change')).toBe(false);
  const delta = reviewQuestions({ ...common, change: {}, filters: [{ key: 'type', value: 'defect' }] });
  expect(delta.some(q => q.name === 'review_current_bug')).toBe(true);
  expect(delta.every(q => q.issue.type === 'defect')).toBe(true);
  expect(reviewQuestions({ ...common, change: {}, filters: [{ key: 'type', value: 'security' }] }).every(q => q.issue.type === 'security')).toBe(true);
});
it('keeps each pass independent and records its declared issue without a follow-up choice', () => {
  const node = { id: 'a.js::run', path: 'a.js', qualified_name: 'run', line: 1, end_line: 1 };
  const change = { before: { source: 'return 1;', partial: false }, diff: { source: '-return 1;\n+return 2;', partial: false } };
  const asked = reviewQuestions({ language: 'javascript', source: 'return 2;', change, filters: [{ key: 'type', value: 'defect' }] });
  const steps = reviewSteps({ node, lines: ['return 2;'], change, asked });
  expect(steps).toHaveLength(1);
  expect(steps[0].state.change).toBeDefined();
  expect(steps[0].questions.follow).toBeUndefined();
  const answers = readAnswers({ review_current_bug: { type: 'noul', noul: .9 } }, steps[0]);
  expect(issuesOf(answers).some(issue => issue.type === 'defect' && issue.probability === .9)).toBe(true);
});
it('counts input usage from every pass rather than only the last response', async () => {
  const node = { path: 'a.js', qualified_name: 'run', line: 1, end_line: 1 };
  const pass = { state: {}, questions: {}, asked: [], calls: [], calledBy: [], neighbors: [], covers: { end_line: 1 } };
  const systemOne = { id: 'test', ask: async () => ({ answers: {}, usage: { input_tokens: 10, output_tokens: 2 } }) };
  const result = await questionMethod({ systemOne, node, steps: [pass, pass] });
  expect(result.response.usage).toEqual({ input_tokens: 20, output_tokens: 4 });
});
it('uses the fixed change and contract readings without adding broad scan questions', () => {
  const node = { id: 'a.js::run', path: 'a.js', qualified_name: 'run', line: 1, end_line: 1 };
  const callers = [{ node: { id: 'a.js::invoke', path: 'a.js', qualified_name: 'invoke', line: 1, end_line: 1 }, lines: ['function invoke() { return run(0); }'] }];
  const change = { before: { source: 'return 1;', partial: false }, diff: { source: '-return 1;\n+return 2;', partial: false } };
  const asked = reviewQuestions({ language: 'javascript', source: 'return 2;', callers, change, filters: [{ key: 'type', value: 'defect' }] });
  const steps = reviewSteps({ node, lines: ['return 2;'], callers, change, asked });
  expect(steps).toHaveLength(2);
  expect(steps[0].state.change).toBeDefined();
  expect(steps[1].state.change).toBeUndefined();
  expect(steps[1].state.evidence[0].source).toContain('run(0)');
  expect(steps.every(s => !s.questions.has_bug && !s.questions.follow)).toBe(true);
});
it('adds delta readings to --since scans, preserves a low broad answer and filters rule-only scans', async () => {
  const { root, base } = await fixture();
  await writeFile(join(root, 'a.js'), 'export function run(x) {\n  return x - 1;\n}\n'); await commitAll(root, 'change');
  const calls = [], script = scriptedSystemOne();
  const service = { ...script, async ask(state, questions) {
    calls.push({ state, questions });
    const result = await script.ask(state, questions);
    if (result.answers.review_current_bug) result.answers.review_current_bug.noul = .95;
    return result;
  } };
  const options = { root, revision: await revision(root), out: join(root, '.perch'), analyzer: createSourceAnalyzer(), systemOne: service, paths: ['a.js'] };
  const ordinary = await scanRepository(options);
  expect(calls.some(c => c.state.change)).toBe(false);
  expect(ordinary.visited[0].review_current_bug).toBeUndefined();
  calls.length = 0;
  const delta = await scanRepository({ ...options, since: base, filters: [{ key: 'type', value: 'defect' }] });
  expect(calls.some(c => c.state.change && c.questions.review_current_bug)).toBe(true);
  expect(delta.visited.some(v => v.review_current_bug === .95)).toBe(true);
  expect(calls.every(c => !c.questions.has_bug)).toBe(true);
  expect(calls.every(c => !c.questions.review_security)).toBe(true);
  await writeFile(join(root, 'perch.yaml'), 'rules:\n  - name: delta-rule\n    each: method\n    sees: change\n    where: "**/*"\n    ensure: Accepted inputs retain their documented result.\n');
  await commitAll(root, 'add delta rule');
  calls.length = 0;
  const ruleRun = await scanRepository({ ...options, revision: await revision(root), since: base, filters: [{ key: 'rule', value: 'delta rule' }] });
  expect(calls).toHaveLength(1);
  expect(Object.keys(calls[0].questions)).toEqual(['delta-rule']);
  expect(ruleRun.visited.some(v => v['delta-rule'] !== undefined)).toBe(true);
});
