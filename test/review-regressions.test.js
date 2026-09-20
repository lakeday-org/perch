import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { parseQuestions } from '../src/ask.js';
import { createSystemOne } from '../src/systemone.js';
import { askUnitSteps, unitSteps } from '../src/units.js';
import { methodSteps } from '../src/questions.js';
import { questionMethod, scanRepository } from '../src/scan.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { addRule, editRule, removeRule } from '../src/rules.js';
import { main } from '../src/cli.js';
import { revision } from '../src/git.js';
import { makeGraphFixture, commitAll, initRepo, scriptedSystemOne } from './helpers.js';

const roots = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const reply = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body), json: async () => body });
const rule = parseQuestions('- name: clean\n  where: example.js\n  ensure: The code checks stock.\n', 'fixture', 'rule')[0];

it.each([
  ['app.cjs', 'exports.read = function() { return helper(); };\nfunction* items() { yield helper(); }', ['exports.read', 'items']],
  ['App.kt', 'class K { fun compute() { helper() } }\nobject O { fun o() = helper() }', ['K.compute', 'O.o']],
  ['App.java', 'class App { App() { helper(); } int compute() { return helper(); } }', ['App.App', 'App.compute']],
  ['App.cs', 'class App { public App() { Helper(); } int Compute() { return Helper(); } }', ['App.App', 'App.Compute']],
  ['app.groovy', 'class Box {\n int size() { return helper() }\n def other(x) { return size() }\n}\n', ['Box.size', 'Box.other']],
])('sends the callable code from a %s-only repository to the model', async (path, source, names) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'perch-callables-'))); roots.push(root);
  await writeFile(join(root, path), source);
  await initRepo(root);
  const systemOne = scriptedSystemOne();
  const run = await scanRepository({root, revision: await revision(root), out:join(root,'.perch'), analyzer:createSourceAnalyzer(), systemOne});
  expect(run.status).toBe('complete');
  expect(run.failed).toEqual([]);
  expect(run.visited.map(method => method.name).sort()).toEqual([...names].sort());
  expect([...new Set(systemOne.calls.filter(call => call.state.method).map(call => call.state.method.name))].sort()).toEqual([...names].sort());
});

it.each([
  [400, 'token expired; request exceeds authorization limit'],
  [422, 'quota exceeded for tokens'],
  [422, 'token quota exceeded'],
  [400, 'maximum tokens per minute exceeded'],
])('keeps HTTP %i auth and quota failures out of size retries: %s', async (status, message) => {
  let requests = 0;
  const client = createSystemOne({ apiKey: 'fixture', fetchImpl: async () => { requests++; return reply(status, { error: message }); } });
  await expect(client.ask({}, { a: { type: 'noul' }, b: { type: 'noul' }, c: { type: 'noul' } })).rejects.toThrow(message);
  expect(requests).toBe(1);
});

it.each(['file', 'method'])('reuses prepared %s source on the first attempt', async kind => {
  const source = 'function order() { return stock; }';
  const node = { path: 'example.js', qualified_name: 'order', line: 1, end_line: 1 };
  const prepare = vi.fn(budget => kind === 'file'
    ? unitSteps({ rules: [rule], unit: node, source, budget })
    : methodSteps({ node, lines: [source], budget }));
  const steps = prepare();
  const systemOne = scriptedSystemOne();
  if (kind === 'file') await askUnitSteps({ systemOne, steps, prepare, rules: [rule] });
  else await questionMethod({ systemOne, steps, prepare, node, lines: [source] });
  expect(prepare).toHaveBeenCalledTimes(1);
});

async function fixture(rules, docs) {
  const root = await realpath(await makeGraphFixture()); roots.push(root);
  await mkdir(join(root, 'docs'));
  for (const [name, source] of Object.entries(docs)) await writeFile(join(root, 'docs', name), source);
  await writeFile(join(root, 'perch.yaml'), rules);
  await commitAll(root, 'rule failure fixture');
  return { root, revision: await revision(root), out: join(root, '.perch'), analyzer: createSourceAnalyzer() };
}

it('records unchunkable file checks and continues other files', async () => {
  const options = await fixture('- name: prose\n  where: docs/*.md\n  ensure: The text explains the API.\n', { 'huge.md': 'word '.repeat(500), 'small.md': 'API reference.' });
  const base = scriptedSystemOne();
  const systemOne = { ...base, limits: { state: 96 } };
  const run = await scanRepository({ ...options, systemOne, paths: ['docs'] });
  expect(run.status).toBe('incomplete');
  expect(run.failed).toEqual([expect.objectContaining({ path: 'docs/huge.md', rule: 'prose' })]);
  expect(run.incomplete.join('\n')).toContain('docs/huge.md');
  expect(base.calls.some(call => call.state.path === 'docs/small.md')).toBe(true);
  expect(JSON.parse(await readFile(join(run.out, 'run.json'), 'utf8')).status).toBe('incomplete');
});

it.each([false, true])('continues past an inconclusive search unit and retains a later witness: %s', async witness => {
  const options = await fixture('- name: evidence\n  where: docs/*.md\n  ensure_present: a verified receipt\n', { 'a.md': 'plain words\n'.repeat(200), 'b.md': witness ? 'verified receipt' : 'nothing here' });
  const base = scriptedSystemOne();
  const systemOne = { ...base, limits: { state: 400 }, async ask(state, questions) {
    if (questions.evidence) return { answers: { evidence: { noul: state.source.includes('verified receipt') ? 0.99 : 0.01 } } };
    return base.ask(state, questions);
  } };
  const run = await scanRepository({ ...options, systemOne, paths: ['docs'], unitParallel: 1 });
  expect(run.status).toBe(witness ? 'complete' : 'incomplete');
  expect(run.incomplete.length).toBe(witness ? 0 : 1);
  expect(run.broken).toHaveLength(0);
  if (!witness) expect(run.incomplete[0]).toContain('cross-piece');
});

it('refuses an add shadowed by an uncommitted nested split rule without changing either file', async () => {
  const root = await realpath(await makeGraphFixture()); roots.push(root);
  await writeFile(join(root, 'perch.yaml'), '# local rules\n[]\n');
  await mkdir(join(root, '.perch/rules/nested'), { recursive: true });
  const text = '- name: duplicate\n  where: src/*.js\n  ensure: Original assertion.\n';
  await writeFile(join(root, '.perch/rules/nested/check.yml'), text);
  await expect(addRule(root, { name: 'duplicate', where: 'src/*.js', ensure: 'Ignored assertion.' })).rejects.toThrow(/already.*\.perch\/rules\/nested\/check.yml/);
  await expect(editRule(root, 'duplicate', { ensure: 'Ignored edit.' })).rejects.toThrow(/edit that file directly/);
  await expect(removeRule(root, 'duplicate')).rejects.toThrow(/edit that file directly/);
  expect(await readFile(join(root, 'perch.yaml'), 'utf8')).toBe('# local rules\n[]\n');
  expect(await readFile(join(root, '.perch/rules/nested/check.yml'), 'utf8')).toBe(text);
});

it('applies the CLI allowance to localization and permits an explicit larger allowance', async () => {
  const {root} = await fixture('- name: prose\n  where: docs/*.md\n  ensure: The text explains the API.\n', { 'bad.md': 'Missing reference.\nMissing example.\n' });
  let requests = 0;
  vi.stubGlobal('fetch', async (_url, init) => {
    requests++;
    const {questions} = JSON.parse(init.body);
    return reply(200, {answers: Object.fromEntries(Object.entries(questions).map(([name,q]) => [name, q.type === 'choice' ? {choice: Object.keys(q.criteria)[0]} : {noul:0.01}]))});
  });
  const output = [];
  const run = limit => main(['scan', root, '--paths', 'docs', '--max-unit-requests', String(limit), '--json'], {
    env: {PERCH_API_KEY:'fixture'}, stdout: text => output.push(text), stderr: () => {},
  });
  expect(await run(1)).toBe(1);
  expect(requests).toBe(1);
  expect(JSON.parse(output.at(-1)).run.incomplete.join('\n')).toContain('request allowance');
  requests = 0;
  expect(await run(2)).toBe(3);
  expect(requests).toBe(2);
  expect(JSON.parse(output.at(-1)).run.status).toBe('complete');
  expect(await run(0)).toBe(2);
});

it('bounds requests across method chunks and leaves exhaustion incomplete', async () => {
  const source = 'function huge() {\n' + '  work();\n'.repeat(300) + '}';
  const node = { path: 'huge.js', qualified_name: 'huge', line: 1, end_line: 302 };
  let requests = 0;
  const scripted = scriptedSystemOne();
  const systemOne = createSystemOne({ apiKey: 'fixture', limits: { state: 600, single: 30000, request: 60000, unitRequests: 4 }, fetchImpl: async (_url, init) => {
    requests++;
    const {state,questions} = JSON.parse(init.body);
    return reply(200, await scripted.ask(state, questions));
  } });
  const prepare = budget => methodSteps({ node, lines: source.split('\n'), budget });
  await expect(questionMethod({ systemOne, node, lines: source.split('\n'), steps: prepare(600), prepare })).rejects.toThrow(/request.*allowance|request.*budget/i);
  expect(requests).toBe(4);
});

it('counts rejected question batches and source retries against the same unit allowance', async () => {
  let requests = 0;
  const rules = parseQuestions('- name: a\n  where: example.js\n  ensure: Code checks stock.\n- name: b\n  where: example.js\n  ensure: Code returns stock.\n', 'fixture', 'rule');
  const systemOne = createSystemOne({ apiKey: 'fixture', limits: { state: 24000, single: 30000, request: 60000, unitRequests: 3 }, fetchImpl: async () => {
    requests++; return reply(413, {error:'too large'});
  } });
  const prepare = budget => unitSteps({rules, unit:{path:'example.js',line:1}, source:'function run() { return stock; }\n'.repeat(500), budget});
  await expect(askUnitSteps({systemOne, rules, steps:prepare(), prepare})).rejects.toThrow(/request.*allowance|request.*budget/i);
  expect(requests).toBe(3);
});
