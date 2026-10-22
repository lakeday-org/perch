import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { createChangeReader } from '../src/change-context.js';
import { checkTarget } from '../src/check.js';
import { issuesOf } from '../src/questions.js';
import { questionMethod, scanRepository } from '../src/scan.js';
import { commitAll, initRepo, makeGraphFixture, scriptedSystemOne } from './helpers.js';

const analyzer = createSourceAnalyzer();
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** The graph fixture with h changed on the branch: it multiplied k(x) by 2 on main and adds 2 here. */
async function branch() {
  const root = await makeGraphFixture(); roots.push(root);
  const path = join(root, 'src', 'b.js');
  await writeFile(path, (await readFile(path, 'utf8')).replace('return k(x) * 2;', 'return k(x) + 2;'));
  await commitAll(root, 'h adds');
  return { root, revision: await revision(root), analyzer, paths: ['src/b.js'] };
}

/** A scripted System One that records each request and answers as `model`, with `has_bug` set per method. */
function service(model = 'scripted-jev', overrides = {}) {
  const script = scriptedSystemOne(overrides), calls = [];
  return { calls, id: model, async ask(state, questions) {
    calls.push({ state, questions });
    return { ...await script.ask(state, questions), model };
  } };
}
const byMethod = calls => new Map(calls.filter(call => call.state.method).map(call => [`${call.state.method.path}::${call.state.method.name}`, call]));

describe('perch scan --since', () => {
  it('asks the questions a full scan asks, in one reading with the previous source and the diff added', async () => {
    const options = await branch();
    const full = service(), since = service();
    await scanRepository({ ...options, out: join(options.root, '.perch-full'), systemOne: full });
    await scanRepository({ ...options, out: join(options.root, '.perch-since'), systemOne: since, since: 'main' });
    const [whole, branched] = [byMethod(full.calls), byMethod(since.calls)];
    expect([...branched.keys()].sort()).toEqual([...whole.keys()].sort());
    // One request per method either way, with the same question names, has_bug and bug_edge_case among them.
    expect(since.calls).toHaveLength(full.calls.length);
    for (const [method, call] of branched) expect(Object.keys(call.questions).sort(), method).toEqual(Object.keys(whole.get(method).questions).sort());
    expect(Object.keys(branched.get('src/b.js::h').questions)).toEqual(expect.arrayContaining(['has_bug', 'bug_edge_case', 'follow']));
    // The method, its callers and callees, and the calls between them, are what a full scan sends.
    const h = branched.get('src/b.js::h').state;
    expect(h.method).toEqual(whole.get('src/b.js::h').state.method);
    expect(h.graph).toEqual(whole.get('src/b.js::h').state.graph);
    expect(h.graph.edges).toEqual(expect.arrayContaining(['src/a.js::f -> src/b.js::h']));
    // And the method as it was at the merge base, with the diff over it.
    expect(h.change.before.source).toContain('return k(x) * 2;');
    expect(h.change.before.source).not.toContain('return k(x) + 2;');
    expect(h.change.diff.source).toContain('-  return k(x) * 2;');
    expect(h.change.diff.source).toContain('+  return k(x) + 2;');
  });

  it('sends a full scan neither the previous source nor the diff', async () => {
    const options = await branch();
    const full = service();
    await scanRepository({ ...options, out: join(options.root, '.perch'), systemOne: full });
    expect(full.calls.length).toBeGreaterThan(0);
    for (const call of full.calls) {
      expect(Object.keys(call.state).sort()).toEqual(['graph', 'method']);
      expect(JSON.stringify(call.state)).not.toContain('return k(x) * 2;');
    }
  });

  it('asks a custom method rule in the same reading with or without --since', async () => {
    const options = await branch();
    await writeFile(join(options.root, 'perch.yaml'), 'rules:\n  - name: h-doubles\n    each: method\n    where: src/b.js\n    ensure: The method returns a number.\n');
    await commitAll(options.root, 'a rule');
    const run = { ...options, revision: await revision(options.root) };
    const full = service(), since = service();
    await scanRepository({ ...run, out: join(options.root, '.perch-full'), systemOne: full });
    await scanRepository({ ...run, out: join(options.root, '.perch-since'), systemOne: since, since: 'main' });
    for (const calls of [full.calls, since.calls]) expect(byMethod(calls).get('src/b.js::h').questions['h-doubles']).toBeDefined();
    expect(since.calls).toHaveLength(full.calls.length);
  });
});

describe('a bug question floor per model', () => {
  const defects = async (model, has_bug, min = 0.5) => {
    const options = await branch();
    const run = await scanRepository({ ...options, out: join(options.root, '.perch'), since: 'main', min, systemOne: service(model, { 'src/b.js::h': { has_bug } }) });
    const h = run.visited.find(event => event.name === 'h');
    // The reading keeps the model that answered it, which is what its floor is read by.
    expect(h.model).toBe(model);
    return issuesOf(h, min).filter(issue => issue.type === 'defect');
  };

  it('lists a gpt-6-luna answer over 80% and a Jev answer over 60%', async () => {
    expect(await defects('gpt-6-luna', 0.7)).toEqual([]);
    expect(await defects('gpt-6-luna', 0.85)).toEqual([expect.objectContaining({ from: 'has_bug', probability: 0.85, floor: 0.8 })]);
    expect(await defects('jev-1.13.0', 0.65)).toEqual([expect.objectContaining({ from: 'has_bug', probability: 0.65, floor: 0.6 })]);
  });

  it('still raises every floor to --min, and --min 0 shows everything', async () => {
    expect(await defects('jev-1.13.0', 0.65, 0.7)).toEqual([]);
    expect(await defects('gpt-6-luna', 0.85, 0.9)).toEqual([]);
    expect(await defects('gpt-6-luna', 0.3, 0)).toEqual([expect.objectContaining({ probability: 0.3, floor: 0 })]);
  });

  it('reads a perch check by the model that answered it', async () => {
    const root = await makeGraphFixture(); roots.push(root);
    const options = { root, revision: await revision(root), out: join(root, '.perch'), analyzer };
    await scanRepository({ ...options, systemOne: service(), paths: [] });
    const check = async model => (await checkTarget({ ...options, target: 'src/b.js::h', systemOne: service(model, { 'src/b.js::h': { has_bug: 0.7 } }) })).issues;
    expect(await check('gpt-6-luna')).toEqual([]);
    expect(await check('jev-latest')).toEqual([expect.objectContaining({ type: 'defect', from: 'has_bug', probability: 0.7 })]);
  });

  it('breaks a method rule by the floor for the model that answered', async () => {
    const options = await branch();
    const rule = 'rules:\n  - name: h-doubles\n    each: method\n    where: src/b.js\n    min:\n      gpt-6-luna: 80\n      default: 60\n    ensure: The method returns a number.\n';
    await writeFile(join(options.root, 'perch.yaml'), rule);
    await commitAll(options.root, 'a rule');
    const broken = async model => (await scanRepository({ ...options, revision: await revision(options.root), out: join(options.root, `.perch-${model}`), since: 'main',
      systemOne: service(model, { 'src/b.js::h': { 'h-doubles': 0.25 } }) })).broken.filter(item => item.name === 'h').map(item => item.rule);
    expect(await broken('gpt-6-luna')).toEqual([]);
    expect(await broken('jev-latest')).toEqual(['h-doubles']);
  });
});

describe('the change a --since reading carries', () => {
  it('reads the merge base, a renamed path and new files without confusing their previous source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-change-')); roots.push(root);
    await writeFile(join(root, 'a.js'), 'export function run(x) {\n  return x + 1;\n}\n');
    await initRepo(root);
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
  });

  it('counts input usage from every pass of a long method rather than only the last', async () => {
    const node = { path: 'a.js', qualified_name: 'run', line: 1, end_line: 1 };
    const pass = { state: {}, questions: {}, asked: [], calls: [], calledBy: [], neighbors: [], covers: { end_line: 1 } };
    const follow = { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1 } };
    const systemOne = { id: 'test', ask: async () => ({ answers: { follow }, usage: { input_tokens: 10, output_tokens: 2 } }) };
    const result = await questionMethod({ systemOne, node, steps: [pass, pass] });
    expect(result.response.usage).toEqual({ input_tokens: 20, output_tokens: 4 });
  });
});
