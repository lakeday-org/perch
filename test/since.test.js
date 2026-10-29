import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { BUILTIN } from '../src/ask.js';
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

/**
 * A branch that changed h. f in a.js calls h, and h calls k, which sits far enough below h in b.js that no diff hunk reaches it.
 * Only h changed, so a --since scan reads h, with f in view as its caller and k as its callee.
 */
async function branch() {
  const root = await mkdtemp(join(tmpdir(), 'perch-since-')); roots.push(root);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), '{ "name": "since", "type": "module" }\n');
  await writeFile(join(root, 'src', 'a.js'), "import { h } from './b.js';\n\nexport function f(x) {\n  return h(x) + 1;\n}\n");
  const apart = Array.from({ length: 12 }, (_, index) => `// ${index}`).join('\n');
  await writeFile(join(root, 'src', 'b.js'), `export function h(x) {\n  return k(x) * 2;\n}\n\n${apart}\n\nexport function k(x) {\n  return x - 1;\n}\n`);
  await initRepo(root);
  const path = join(root, 'src', 'b.js');
  await writeFile(path, (await readFile(path, 'utf8')).replace('return k(x) * 2;', 'return k(x) + 2;'));
  await commitAll(root, 'h adds');
  return { root, revision: await revision(root), analyzer, paths: ['src/b.js'] };
}

/** A scripted System One that records each request and answers as `model`, with answers set per method. */
function service(model = 'scripted-jev', overrides = {}) {
  const script = scriptedSystemOne(overrides), calls = [];
  return { calls, id: model, async ask(state, questions) {
    calls.push({ state, questions });
    return { ...await script.ask(state, questions), model };
  } };
}
/** Every request about one method, in the order they were sent. */
const requests = (calls, method) => calls.filter(call => call.state.method && `${call.state.method.path}::${call.state.method.name}` === method);
const BUGS = ['bug_edge_case', 'has_bug', 'kind', 'severity'];
const RULE = 'rules:\n  - name: h-doubles\n    each: method\n    where: src/b.js\n    ensure: The method returns a number.\n';

describe('perch scan --since', () => {
  it('asks a function the diff changed the bug questions over the function and the diff, with no graph', async () => {
    const options = await branch();
    const full = service(), since = service();
    await scanRepository({ ...options, out: join(options.root, '.perch-full'), systemOne: full });
    await scanRepository({ ...options, out: join(options.root, '.perch-since'), systemOne: since, since: 'main' });
    const [h] = requests(since.calls, 'src/b.js::h');
    expect(requests(since.calls, 'src/b.js::h')).toHaveLength(1);
    // The four questions a full scan asks, worded and shaped as it asks them, and no follow.
    expect(Object.keys(h.questions).sort()).toEqual(BUGS);
    const [whole] = requests(full.calls, 'src/b.js::h');
    for (const name of BUGS) expect(h.questions[name], name).toEqual(whole.questions[name]);
    // The function and its change, and no callers, callees or graph.
    expect(Object.keys(h.state).sort()).toEqual(['change', 'method', 'reading']);
    expect(h.state.method).toMatchObject({ path: 'src/b.js', name: 'h', start_line: 1 });
    expect(h.state.method.source).toContain('return k(x) + 2;');
    expect(JSON.stringify(h.state)).not.toContain('src/a.js');
    expect(h.state.change.before.source).toContain('return k(x) * 2;');
    expect(h.state.change.before.source).not.toContain('return k(x) + 2;');
    expect(h.state.change.diff.source).toContain('-  return k(x) * 2;');
    expect(h.state.change.diff.source).toContain('+  return k(x) + 2;');
  });

  it('does not read a function in a changed file that no hunk touches', async () => {
    const options = await branch();
    const since = service();
    const run = await scanRepository({ ...options, out: join(options.root, '.perch'), systemOne: since, since: 'main' });
    expect(requests(since.calls, 'src/b.js::k')).toEqual([]);
    expect(since.calls).toHaveLength(1);
    expect(run.methods).toBe(1);
  });

  it('asks security questions only of a function the diff changed', async () => {
    const options = await branch();
    const since = service();
    await scanRepository({ ...options, out: join(options.root, '.perch'), systemOne: since, since: 'main',
      filters: [{ key: 'type', value: 'defect' }, { key: 'type', value: 'lint' }, { key: 'type', value: 'security' }] });
    expect(requests(since.calls, 'src/b.js::k')).toEqual([]);
    expect(requests(since.calls, 'src/b.js::h').length).toBeGreaterThan(0);
  });

  it('asks a rule shown a document only of a function the diff changed', async () => {
    const options = await branch();
    await writeFile(join(options.root, 'src', 'GLOSSARY.md'), 'A number is a number.\n');
    await writeFile(join(options.root, 'perch.yaml'), 'rules:\n  - name: uses-glossary\n    each: method\n    where: src/b.js\n    context: GLOSSARY.md\n    ensure: The method uses the words the glossary defines.\n');
    await commitAll(options.root, 'a rule with a document');
    const path = join(options.root, 'src', 'b.js');
    await writeFile(path, (await readFile(path, 'utf8')).replace('return k(x) + 2;', 'return k(x) + 3;'));
    await commitAll(options.root, 'h adds more');
    const since = service();
    await scanRepository({ ...options, revision: await revision(options.root), out: join(options.root, '.perch'), systemOne: since, since: 'HEAD~1' });
    const asked = since.calls.filter(call => 'uses-glossary' in call.questions);
    expect(asked.map(call => JSON.stringify(call.state))).toEqual([expect.stringContaining('k(x) + 3')]);
  });

  it('asks a custom rule on --since over callers and callees, in the request a full scan sends', async () => {
    const options = await branch();
    await writeFile(join(options.root, 'perch.yaml'), RULE);
    await commitAll(options.root, 'a rule');
    const run = { ...options, revision: await revision(options.root) };
    const full = service(), since = service();
    await scanRepository({ ...run, out: join(options.root, '.perch-full'), systemOne: full });
    const read = await scanRepository({ ...run, out: join(options.root, '.perch-since'), systemOne: since, since: 'main' });
    // h was changed, so it is two requests: the diff, then the ordinary one with the rule and follow.
    const [diff, ordinary] = requests(since.calls, 'src/b.js::h');
    expect(requests(since.calls, 'src/b.js::h')).toHaveLength(2);
    expect(Object.keys(diff.questions).sort()).toEqual(BUGS);
    expect(Object.keys(ordinary.questions).sort()).toEqual(['follow', 'h-doubles']);
    // The ordinary request's state is the one a full scan sends: h, its caller f, its callee k, and the calls between them.
    expect(ordinary.state).toEqual(requests(full.calls, 'src/b.js::h')[0].state);
    expect(ordinary.state.graph.edges).toEqual(expect.arrayContaining(['src/a.js::f -> src/b.js::h', 'src/b.js::h -> src/b.js::k']));
    // k was not changed, so it is not asked the rule either.
    expect(requests(since.calls, 'src/b.js::k')).toEqual([]);
    expect(read.methods).toBe(1);
    // Both requests' answers land on h's one reading.
    const h = read.visited.find(event => event.name === 'h');
    expect(h).toMatchObject({ has_bug: expect.any(Number), bug_edge_case: expect.any(Number), 'h-doubles': expect.any(Number) });
    expect(h.follow).toBeDefined();
    expect(Object.keys(h.answer_hashes).sort()).toEqual([...BUGS, 'h-doubles'].sort());
  });

  it('leaves a full scan as it was: one request per function, with its callers and callees', async () => {
    const options = await branch();
    const full = service();
    await scanRepository({ ...options, out: join(options.root, '.perch'), systemOne: full });
    expect(full.calls).toHaveLength(2);
    for (const call of full.calls) {
      expect(Object.keys(call.state).sort()).toEqual(['graph', 'method']);
      expect(Object.keys(call.questions).sort()).toEqual([...BUGS, 'follow'].sort());
      expect(JSON.stringify(call.state)).not.toContain('return k(x) * 2;');
    }
    expect(requests(full.calls, 'src/b.js::h')[0].state.graph.edges).toEqual(expect.arrayContaining(['src/a.js::f -> src/b.js::h']));
  });
});

describe('a bug question floor per model', () => {
  /** b.js changed on a branch whose perch.yaml gives has_bug a floor of 80% from gpt-6-luna and 60% from every other model. */
  async function perModel() {
    const options = await branch();
    const has_bug = { ...BUILTIN.find(question => question.name === 'has_bug').declared, min: { 'gpt-6-luna': 80, default: 60 } };
    await writeFile(join(options.root, 'perch.yaml'), stringify({ rules: [has_bug] }));
    await commitAll(options.root, 'has_bug floors by model');
    return { ...options, revision: await revision(options.root) };
  }
  const defects = async (model, has_bug, min = 0.5, options = null) => {
    options ??= await branch();
    const run = await scanRepository({ ...options, out: join(options.root, `.perch-${model}-${min}`), since: 'main', min, systemOne: service(model, { 'src/b.js::h': { has_bug } }) });
    const h = run.visited.find(event => event.name === 'h');
    // The reading keeps the model that answered it, which is what its floor is read by.
    expect(h.model).toBe(model);
    return issuesOf(h, min).filter(issue => issue.type === 'defect');
  };

  it('lists a bug answer over 60% from gpt-6-luna and from Jev, as perch ships it', async () => {
    expect(await defects('gpt-6-luna', 0.6)).toEqual([]);
    expect(await defects('gpt-6-luna', 0.65)).toEqual([expect.objectContaining({ from: 'has_bug', probability: 0.65, floor: 0.6 })]);
    expect(await defects('jev-1.13.0', 0.65)).toEqual([expect.objectContaining({ from: 'has_bug', probability: 0.65, floor: 0.6 })]);
  });

  it('lists a gpt-6-luna answer over 80% and a Jev answer over 60% when perch.yaml maps has_bug\'s floor by model', async () => {
    const options = await perModel();
    expect(await defects('gpt-6-luna', 0.7, 0.5, options)).toEqual([]);
    expect(await defects('gpt-6-luna', 0.85, 0.5, options)).toEqual([expect.objectContaining({ from: 'has_bug', probability: 0.85, floor: 0.8 })]);
    expect(await defects('jev-1.13.0', 0.65, 0.5, options)).toEqual([expect.objectContaining({ from: 'has_bug', probability: 0.65, floor: 0.6 })]);
  });

  it('still raises every floor to --min, and --min 0 shows everything', async () => {
    const options = await perModel();
    expect(await defects('jev-1.13.0', 0.65, 0.7, options)).toEqual([]);
    expect(await defects('gpt-6-luna', 0.85, 0.9, options)).toEqual([]);
    expect(await defects('gpt-6-luna', 0.3, 0, options)).toEqual([expect.objectContaining({ probability: 0.3, floor: 0 })]);
  });

  it('reads a perch check by the model that answered it', async () => {
    const root = await makeGraphFixture(); roots.push(root);
    const has_bug = { ...BUILTIN.find(question => question.name === 'has_bug').declared, min: { 'gpt-6-luna': 80, default: 60 } };
    await writeFile(join(root, 'perch.yaml'), stringify({ rules: [has_bug] }));
    await commitAll(root, 'has_bug floors by model');
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
