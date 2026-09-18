import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { check } from '../src/ask.js';
import { rulesFor } from '../src/check.js';
import { expand, matches, neighbourhood, rank, readLint, readRules, selectUnits, testBlocks, unitStep } from '../src/units.js';
import { scanRepository } from '../src/scan.js';
import { openStore } from '../src/store.js';
import { commitAll, makeGraphFixture } from './helpers.js';

const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** The graph fixture, plus rules to run over it. */
async function repoWith(rules) {
  const root = await makeGraphFixture();
  cleanups.push(root);
  await writeFile(join(root, 'perch.yaml'), rules);
  await writeFile(join(root, 'README.md'), '# graph\n\nA fixture.\n');
  await commitAll(root, 'rules');
  return { root, revision: await revision(root), out: join(root, '.perch') };
}

/** Answers every question in a request the same way: how sure each noul is, and the last option of every choice. */
const answering = (value, calls = []) => ({
  id: 'scripted-jev', calls,
  async ask(state, questions) {
    calls.push({ state, questions });
    const answers = {};
    for (const [id, question] of Object.entries(questions)) {
      if (question.type === 'noul') { answers[id] = { type: 'noul', noul: value }; continue; }
      if (question.type === 'score') { answers[id] = { type: 'score', score: 1, confidence: 0.6, probabilities: Object.fromEntries(question.criteria.map((_, index) => [index, index === 1 ? 0.7 : 0.1])) }; continue; }
      const keys = Object.keys(question.criteria);
      const choice = keys.includes(value) ? value : keys.at(-1);
      answers[id] = { type: 'choice', choice, confidence: 0.9, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 0.9 : 0.1 / (keys.length - 1)])) };
    }
    return { model: 'scripted-jev', answers, usage: { input_tokens: 10, output_tokens: 0 } };
  },
});

describe('code perch.yaml says not to read', () => {
  it('takes ignore from the map form, and leaves a bare list a list of rules', async () => {
    const { parseIgnored, parseQuestions } = await import('../src/ask.js');
    const list = '- name: r\n  where: "**/*"\n  ensure: x\n';
    // A bare list is what the file has always been, and has no ignore in it.
    expect(parseQuestions(list, 'perch.yaml', 'rule')).toHaveLength(1);
    expect(parseIgnored(list, 'perch.yaml')).toEqual([]);
    // The map form carries both. A fixture with a bug in every method on purpose is read by nothing.
    const map = 'ignore:\n  - perch-example/**\nrules:\n' + list.split('\n').map(l => l && '  ' + l).join('\n');
    expect(parseQuestions(map, 'perch.yaml', 'rule')).toHaveLength(1);
    expect(parseIgnored(map, 'perch.yaml')).toEqual(['perch-example/**']);
    expect(matches('perch-example/**', 'perch-example/cart.py')).toBe(true);
    expect(matches('perch-example/**', 'src/cart.js')).toBe(false);
    // A file that reads as neither is a file somebody wrote wrong, and is said so rather than asking none of their rules.
    expect(() => parseQuestions('just a string\n', 'perch.yaml', 'rule')).toThrow('expected a list of rules');
    expect(() => parseIgnored('ignore: nope\n', 'perch.yaml')).toThrow('ignore is a list of globs');
  });
});

describe('a glob with alternatives in it', () => {
  it('takes {a,b} as the list a person means, since a rule over two places is one rule', () => {
    // Written as a pattern, `{` and `}` were escaped and matched literally, so a where nobody could see was wrong covered
    // nothing and said nothing: the rule was asked of no file and reported as passing.
    expect(expand('{README.md,docs/**/*.md}')).toEqual(['README.md', 'docs/**/*.md']);
    expect(matches('{README.md,docs/**/*.md}', 'README.md')).toBe(true);
    expect(matches('{README.md,docs/**/*.md}', 'docs/cli.md')).toBe(true);
    expect(matches('{README.md,docs/**/*.md}', 'src/cli.js')).toBe(false);
    // The extension form, which is how most people reach for it.
    expect(matches('src/**/*.{js,ts}', 'src/treesitter/index.ts')).toBe(true);
    expect(matches('src/**/*.{js,ts}', 'src/a.rs')).toBe(false);
    // Nested, and more than one brace in a glob.
    expect(expand('{a,{b,c}}.md')).toEqual(['a.md', 'b.md', 'c.md']);
    expect(expand('{x,y}/{1,2}')).toEqual(['x/1', 'x/2', 'y/1', 'y/2']);
    // A brace that never closes is a brace, not a list, and is matched as one.
    expect(expand('{unclosed')).toEqual(['{unclosed']);
    expect(matches('{unclosed', '{unclosed')).toBe(true);
    // Everything without a brace is untouched.
    expect(expand('**/*.md')).toEqual(['**/*.md']);
  });
});

describe('which rules cover one point in the code', () => {
  const rule = (name, extra) => check({ name, where: '**/*.md', ensure: 'A person wrote this.', ...extra }, 'perch.yaml rule 1');
  const file = { path: 'skill.md', name: 'skill.md', part: false };

  it('spares a file the rule excepts, the same as a scan does', () => {
    const covers = rulesFor([rule('prose')], file).map(one => one.name);
    expect(covers).toEqual(['prose']);
    // Left out of this, `perch check` asked a rule about the one file its author had said it did not cover, so check and a scan
    // disagreed about which rules apply to a path.
    expect(rulesFor([rule('prose', { except: 'skill.md' })], file)).toEqual([]);
    expect(rulesFor([rule('prose', { except: 'skill.md' })], { ...file, path: 'README.md', name: 'README.md' })).toHaveLength(1);
  });
});

describe('the units a rule is asked about', () => {
  it('matches the two wildcards a rule file needs', () => {
    for (const [glob, path, want] of [
      ['**/*.md', 'README.md', true], ['**/*.md', 'doc/fix.md', true], ['**/*.md', 'src/a.js', false],
      ['src/**/*.js', 'src/cli.js', true], ['src/**/*.js', 'src/treesitter/deep/x.js', true], ['src/**/*.js', 'test/a.js', false],
      ['test/**/*.js', 'test/cli.test.js', true], ['src/*.js', 'src/nested/a.js', false],
    ]) expect([glob, path, matches(glob, path)]).toEqual([glob, path, want]);
  });

  it('reads rules, and refuses one it cannot act on', async () => {
    const repo = await repoWith('- name: prose\n  where: "**/*.md"\n  ensure: >\n    A person wrote this.\n');
    const [rule] = await readRules(repo.root, repo.revision);
    // A folded scalar is one string, and the wording is hashed so editing it re-asks the question.
    expect(rule).toMatchObject({ name: 'prose', kind: 'ensure', ensure: 'A person wrote this.\n', where: '**/*.md' });
    expect(rule.hash).toHaveLength(64);

    const missing = await repoWith('- name: nowhere\n  ensure: "Something"\n');
    await expect(readRules(missing.root, missing.revision)).rejects.toThrow('needs where to say what it applies to');
    const unnamed = await repoWith('- ensure: "Something"\n');
    await expect(readRules(unnamed.root, unnamed.revision)).rejects.toThrow('every rule needs a name');
  });

  it('selects files, methods, callers and mentions', async () => {
    const repo = await repoWith('- name: r\n  where: "**/*.md"\n  ensure: "x"\n');
    const { analyzeTree } = await import('../src/analyze.js');
    const { buildGraph } = await import('../src/graph.js');
    const scan = await analyzeTree({ root: repo.root, revision: repo.revision, out: repo.out, analyzer });
    const graph = buildGraph(scan.files);
    const { readFile } = await import('node:fs/promises');
    const { listTree } = await import('../src/git.js');
    const files = new Map();
    for (const file of scan.files) files.set(file.path, await readFile(join(repo.root, file.path), 'utf8'));
    const tree = await listTree(repo.root, repo.revision);
    const at = (rule, extra = {}) => selectUnits({ name: 'r', at: 'perch.yaml rule 1', ...rule, ...extra }, { scan, graph, files, tree });

    expect(at({ where: 'src/*.js' }).map(unit => unit.path).sort()).toEqual(['src/a.js', 'src/b.js']);
    expect(at({ where: 'src/*.js', each: 'method' }).map(unit => unit.name).sort()).toEqual(['f', 'g', 'h', 'k']);
    // A file marked as a test is not linted as source.
    expect(at({ where: '**/*.js', each: 'method' }).every(unit => !unit.path.startsWith('test/'))).toBe(true);
    // The graph supplies the callers; h is called by f.
    expect(at({ where: 'callers of h' }).map(unit => unit.name)).toEqual(['f']);
    expect(() => at({ where: 'callers of nosuchmethod' })).toThrow('no method named nosuchmethod');
    // mentions is text, and says so: it finds the methods worth asking about.
    expect(at({ where: 'mentions x - 1' }).map(unit => unit.name)).toEqual(['k']);
  });

  it('shows a file or a test only itself, unless the rule says it needs more', async () => {
    const repo = await repoWith('- name: r\n  where: "**/*.md"\n  ensure: "x"\n');
    const { analyzeTree } = await import('../src/analyze.js');
    const { buildGraph } = await import('../src/graph.js');
    const scan = await analyzeTree({ root: repo.root, revision: repo.revision, out: repo.out, analyzer });
    const graph = buildGraph(scan.files);
    const files = new Map();
    for (const file of scan.files) files.set(file.path, await readFile(join(repo.root, file.path), 'utf8'));
    const file = { id: 'README.md', path: 'README.md', name: 'README.md', line: 1 };
    files.set('README.md', '# graph\n\nCalls f and nothing else.\n');

    // Nothing by default: a claim about one file is answered by that file, and neighbours are more things to answer about by
    // mistake. A method needs no such key at all, and asking for one is refused rather than ignored.
    expect(neighbourhood('self', file, { graph, files })).toEqual({});
    expect(neighbourhood('file', file, { graph, files }).file_source).toContain('Calls f');
    expect(() => check({ name: 'r', where: 'src/**', each: 'method', sees: 'calls', ensure: 'x' }, 'perch.yaml rule 1'))
      .toThrow('a method is always asked with its callers and callees in view');

    // A file and a test are not nodes in the call graph, so what they call is found by name in the body.
    const test = { id: 'test/a.test.js::t', path: 'test/a.test.js', name: 't', line: 1, end_line: 3, part: true };
    files.set('test/a.test.js', 'it("t", () => { f(1); });');
    const seen = neighbourhood('calls', test, { graph, files });
    expect(seen.calls.map(item => item.name)).toContain('f');
    // What is seen goes in the state beside the source, under a name that says what it is.
    const rule = check({ name: 't', where: 'test/**', each: 'test', sees: 'calls', ensure: 'x' }, 'perch.yaml rule 1');
    const { state } = unitStep({ rules: [rule], unit: test, source: 'it("t", () => {});', seen });
    expect(state.calls[0]).toMatchObject({ name: expect.any(String), path: expect.any(String), source: expect.any(String) });
  });

  it('asks a noul either way, and reads it as broken or as found depending on which way the rule was asked', () => {
    // The answer comes back under the rule's own name, since a rule is one entry in the same question set a scan is asked from.
    const rule = check({ name: 'r', where: '**/*', ensure: 'The comment says why.' }, 'test');
    const step = unitStep({ rules: [rule], unit: { path: 'src/a.js', name: 'f', line: 3, part: true }, source: 'function f() {}' });
    expect(step.questions.r.type).toBe('noul');
    expect(step.state).toMatchObject({ path: 'src/a.js', name: 'f', line: 3 });
    expect(readLint(rule, { r: { noul: 0.2 } }).broken).toBeCloseTo(0.8);

    // A search asks whether the thing is here. Wanting it and not wanting it read the same answer opposite ways.
    const exist = check({ name: 'e', where: '**/*', ensure_present: 'A test that closes an issue.' }, 'test');
    const nexist = check({ name: 'n', where: '**/*', ensure_absent: 'A flag parsed and never used.' }, 'test');
    expect(unitStep({ rules: [exist], unit: { path: 'test/a.test.js', name: 'test/a.test.js', line: 1 }, source: '' }).questions.e.type).toBe('noul');
    expect(readLint(exist, { e: { noul: 0.9 } })).toMatchObject({ here: 0.9, broken: 0 });
    expect(readLint(nexist, { n: { noul: 0.9 } })).toMatchObject({ here: 0.9, broken: 0.9 });
  });

  it('takes a test as a unit, so a search names the test and not the file it is in', () => {
    const source = [
      "describe('issues', () => {",
      "  it('lists what a scan found', async () => {",
      '    expect(out).toContain(id);',
      '  });',
      "  it.each([1])('closes an issue %i', async () => {",
      '    await main([`close`, id]);',
      '  });',
      '});',
    ].join('\n');
    expect(testBlocks(source, 'test/cli.test.js')).toEqual([
      { id: 'test/cli.test.js::lists what a scan found', path: 'test/cli.test.js', name: 'lists what a scan found', line: 2, end_line: 4, part: true },
      { id: 'test/cli.test.js::closes an issue %i', path: 'test/cli.test.js', name: 'closes an issue %i', line: 5, end_line: 8, part: true },
    ]);
  });

  it('asks the likeliest unit first, so a search that finds its answer stops there', () => {
    const rule = { name: 'r', kind: 'ensure_present', text: 'A test that closes an issue with a reason' };
    const units = [{ path: 'test/graph.test.js', name: 'graph' }, { path: 'test/cli.test.js', name: 'closes an issue' }, { path: 'test/scan.test.js', name: 'scan' }];
    expect(rank(rule, units)[0].name).toBe('closes an issue');
  });

  it('asks a method rule inside that method\'s own reading, and a file rule on its own', async () => {
    const repo = await repoWith('- name: comment-says-why\n  where: "src/*.js"\n  each: method\n  ensure: "The comment says why."\n'
      + '- name: prose\n  where: "**/*.md"\n  ensure: "A person wrote this."\n');
    const calls = [];
    const run = await scanRepository({ ...repo, analyzer, systemOne: answering(0.1, calls) });

    // Four methods, each one request carrying perch's questions and the rule together. A rule about a method costs no request.
    expect(run.calls).toBe(4);
    expect(calls.filter(call => call.questions['comment-says-why'])).toHaveLength(4);
    expect(calls.filter(call => call.questions.has_bug && call.questions['comment-says-why'])).toHaveLength(4);
    // The markdown rule is not about a method, so it is its own reading.
    const prose = calls.filter(call => call.questions.prose);
    expect(prose).toHaveLength(1);
    expect(prose[0].questions.has_bug).toBeUndefined();

    // The run tallies every rule that broke, whatever it was asked about.
    expect(run.broken.map(finding => finding.rule).sort()).toEqual(['comment-says-why', 'comment-says-why', 'comment-says-why', 'comment-says-why', 'prose']);
    expect(run.broken[0].broken).toBeCloseTo(0.9);

    // A rule asked inside a method's reading is answered there, so it is not written down a second time: one problem, one row.
    const store = openStore(repo.out);
    const rows = await store.readLines(store.scanPath);
    expect(rows.filter(row => row.answers_set)).toHaveLength(4);
    expect(rows.filter(row => row.answers_set).every(row => row['comment-says-why'] === 0.1)).toBe(true);
    // The markdown rule has no reading to sit inside, so it is a finding of its own.
    expect(rows.filter(row => row.rule).map(row => row.rule)).toEqual(['prose']);
  });

  it('asks two rules about one file in one request, and one more only where they differ', async () => {
    const repo = await repoWith('- name: prose\n  where: "**/*.md"\n  ensure: "A person wrote this."\n'
      + '- name: terse\n  where: "**/*.md"\n  ensure: "It is short."\n'
      + '- name: grounded\n  where: "**/*.md"\n  sees: file\n  ensure: "It names something real."\n');
    const calls = [];
    await scanRepository({ ...repo, analyzer, systemOne: answering(0.9, calls) });
    const onReadme = calls.filter(call => call.state.file === 'README.md');
    // Two rules seeing the same thing share a request; the third wants more, so it is a second context.
    expect(onReadme).toHaveLength(2);
    expect(Object.keys(onReadme[0].questions).sort()).toEqual(['prose', 'terse']);
    expect(Object.keys(onReadme[1].questions)).toEqual(['grounded']);
    expect(onReadme[1].state.file_source).toContain('A fixture.');
  });

  it('asks only about what a branch changed', async () => {
    const repo = await repoWith('- name: prose\n  where: "**/*.md"\n  ensure: "A person wrote this."\n');
    await mkdir(join(repo.root, 'doc'), { recursive: true });
    await writeFile(join(repo.root, 'doc', 'one.md'), '# one\n');
    await writeFile(join(repo.root, 'doc', 'two.md'), '# two\n');
    await commitAll(repo.root, 'docs');
    const at = await revision(repo.root);

    // --since is the universe, not a filter over something kept: a narrowed run asks about those files and reports on them.
    const narrowed = await scanRepository({ ...repo, revision: at, analyzer, systemOne: answering(0.1), paths: ['src', 'doc/one.md'] });
    expect(narrowed.broken.map(finding => finding.path)).toEqual(['doc/one.md']);

    const everything = await scanRepository({ ...repo, revision: at, analyzer, systemOne: answering(0.1) });
    expect(everything.broken.map(finding => finding.path).sort()).toEqual(['README.md', 'doc/one.md', 'doc/two.md']);
  });
});
