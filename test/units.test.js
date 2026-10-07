import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { revision } from '../src/git.js';
import { analyzeFiles, createSourceAnalyzer, sourceFile } from '../src/analysis.js';
import { buildGraph } from '../src/graph.js';
import { check } from '../src/ask.js';
import { checkTarget, resolveTarget, rulesFor } from '../src/check.js';
import { bodyOf, expand, matches, neighbourhood, rank, readLint, readRules, selectUnits, unitStep } from '../src/units.js';
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
    const map = 'ignore:\n  - test/fixtures/order-service/**\nrules:\n' + list.split('\n').map(l => l && '  ' + l).join('\n');
    expect(parseQuestions(map, 'perch.yaml', 'rule')).toHaveLength(1);
    expect(parseIgnored(map, 'perch.yaml')).toEqual(['test/fixtures/order-service/**']);
    expect(matches('test/fixtures/order-service/**', 'test/fixtures/order-service/cart.py')).toBe(true);
    expect(matches('test/fixtures/order-service/**', 'src/cart.js')).toBe(false);
    // A trailing ** is every depth below, not one level: perch.yaml's ignore of test/fixtures/** has to cover a test two
    // directories down. It does not reach a sibling that only starts with the same name.
    expect(matches('test/fixtures/**', 'test/fixtures/order-service/tests/test_order_service.py')).toBe(true);
    expect(matches('test/fixtures/**', 'test/fixturesx/a.py')).toBe(false);
    expect(matches('**', 'a/b/c.js')).toBe(true);
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

  it('refuses a glob whose braces write out to more than a person means, naming it', () => {
    const glob = `${'{a,b}'.repeat(20)}.md`;
    // A million alternatives, each tried against every path in the tree, from one line of perch.yaml.
    expect(() => matches(glob, 'a.md')).toThrow(`${glob}: more than 256 alternatives in its braces`);
    expect(expand('{a,b}'.repeat(8))).toHaveLength(256);
  });
});

describe('a glob written against the matcher', () => {
  it('answers in the time it takes to read the glob and the path, however many wildcards it has', () => {
    // As a regular expression, ten `**/` against a path forty directories deep ran for minutes: every one of them could take
    // any share of the directories, and the engine tried each way before saying no.
    const deep = `${'a/'.repeat(40)}y`;
    const started = performance.now();
    expect(matches(`${'**/'.repeat(10)}x`, deep)).toBe(false);
    expect(matches(`${'**/'.repeat(10)}y`, deep)).toBe(true);
    expect(matches(`${'*'.repeat(30)}x`, 'a'.repeat(3000))).toBe(false);
    expect(matches(`${'**/a/'.repeat(12)}*`, deep)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('keeps `**/` to whole directories and `*` inside one name', () => {
    for (const [glob, path, want] of [
      ['**/x', 'x', true], ['**/x', 'a/b/x', true], ['**/x', 'ax', false], ['a/**/b', 'a/b', true], ['a/**/b', 'a/x/y/b', true],
      ['a/**/b', 'ab', false], ['src/**', 'src/a.js', true], ['src/**', 'src/a/b.js', true], ['*.md', 'a/b.md', false],
      ['a*b', 'a/b', false], ['a?b', 'a?b', true], ['a?b', 'axb', false], ['', '', true], ['*', '', true],
    ]) expect([glob, path, matches(glob, path)]).toEqual([glob, path, want]);
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

  it('asks a mentions rule and a callers-of rule about the methods a scan would ask them about', async () => {
    const repo = await repoWith([
      '- name: counts-down', '  where: mentions x - 1', '  each: method', '  ensure: "x"',
      '- name: calls-h', '  where: callers of h', '  each: method', '  ensure: "x"', ''].join('\n'));
    const asked = async target => {
      const calls = [];
      const checked = await checkTarget({ target, root: repo.root, out: repo.out, analyzer, systemOne: answering(0.1, calls),
        revision: repo.revision, only: ['counts-down', 'calls-h'] });
      return { checked: checked.checked, rules: calls.flatMap(call => Object.keys(call.questions)).sort() };
    };
    // Matched against the path, neither `where` named src/b.js or src/a.js, so check asked nothing a scan asks.
    expect(await asked('src/b.js::k')).toEqual({ checked: 1, rules: ['counts-down'] });
    expect(await asked('src/a.js::f')).toEqual({ checked: 1, rules: ['calls-h'] });
    expect(await asked('src/a.js::g')).toEqual({ checked: 0, rules: [] });
  });
});

it('does not read a check target outside the repository, including through a symlink', async () => {
  const repo = await repoWith('');
  const external = await mkdtemp(join(tmpdir(), 'perch-external-'));
  cleanups.push(external);
  await writeFile(join(external, 'private.js'), 'const secret = true;\n');
  await symlink(join(external, 'private.js'), join(repo.root, 'linked.js'));
  await expect(resolveTarget({ target: relative(repo.root, join(external, 'private.js')), root: repo.root, out: repo.out })).rejects.toThrow(/outside this repository/);
  await expect(resolveTarget({ target: join(external, 'private.js'), root: repo.root, out: repo.out })).rejects.toThrow(/outside this repository/);
  await expect(resolveTarget({ target: 'linked.js', root: repo.root, out: repo.out })).rejects.toThrow(/outside this repository/);
  expect((await resolveTarget({ target: 'src/a.js', root: repo.root, out: repo.out })).path).toBe('src/a.js');
});

describe('the units a rule is asked about', () => {
  it('applies the scanner exclusions to file units', () => {
    const skipped = ['vendor', 'node_modules', 'dist', 'target', '.git', '.perch', '.lakeday', 'build', 'coverage'];
    const paths = ['src/kept.js', 'src/building/kept.js', 'src/kept.min.js',
      ...skipped.flatMap(dir => [`${dir}/skip.js`, `packages/app/${dir}/skip.js`])];
    const tree = paths.map(path => ({ path, type: 'blob', size: 10, sha: path }));
    tree.push({ path: 'submodule.js', type: 'commit', size: 0, sha: 'submodule' });
    const files = new Map(tree.map(item => [item.path, "test('example', () => {});\n"]));
    const selected = selectUnits({ where: '**/*.js', each: 'file' }, { tree, files }).map(unit => unit.path);
    expect(selected).toEqual(['src/kept.js', 'src/building/kept.js']);
    expect(tree.filter(sourceFile).map(item => item.path)).toEqual(selected);
  });

  it('sends only eligible files to file rules while retaining non-source text', async () => {
    const repo = await repoWith('- name: eligible\n  where: "**/*"\n  ensure: "x"\n');
    const additions = [
      ['node_modules/dependency/index.js', 'export function dependency() {}'],
      ['dist/output.js', 'export function generated() {}'],
      ['src/bundle.min.js', 'export function minified() {}'],
      ['vendor/README.md', 'Dependency documentation'],
      ['docs/guide.md', 'Project documentation'],
      ['notes.txt', 'Project notes'],
    ];
    for (const [path, source] of additions) {
      await mkdir(join(repo.root, path, '..'), { recursive: true });
      await writeFile(join(repo.root, path), source);
    }
    await commitAll(repo.root, 'file exclusions');
    const calls = [];
    const run = await scanRepository({ ...repo, revision: await revision(repo.root), analyzer, systemOne: answering(0.9, calls) });
    const expected = ['README.md', 'docs/guide.md', 'notes.txt', 'package.json', 'src/a.js', 'src/b.js', 'test/a.test.js'];
    expect(calls.filter(call => call.questions.eligible).map(call => call.state.file).sort()).toEqual(expected);
    expect(run.coverage.find(rule => rule.name === 'eligible').units).toBe(expected.length);
  });

  it('matches the two wildcards a rule file needs', () => {
    for (const [glob, path, want] of [
      ['**/*.md', 'README.md', true], ['**/*.md', 'doc/fix.md', true], ['**/*.md', 'src/a.js', false],
      ['src/**/*.js', 'src/cli.js', true], ['src/**/*.js', 'src/treesitter/deep/x.js', true], ['src/**/*.js', 'test/a.js', false],
      ['test/**/*.js', 'test/cli.test.js', true], ['src/*.js', 'src/nested/a.js', false],
    ]) expect([glob, path, matches(glob, path)]).toEqual([glob, path, want]);
  });

  it('reads `dir/**` as everything under the directory, at any depth', () => {
    for (const [glob, path, want] of [
      ['src/**', 'src/a.js', true], ['src/**', 'src/a/b.js', true], ['src/**', 'src/a/b/c.js', true],
      ['src/**', 'src', false], ['src/**', 'srcs/a.js', false], ['src/**', 'test/src/a.js', false],
      ['test/fixtures/**', 'test/fixtures/order-service/cart.py', true], ['**', 'a/b.js', true],
      ['a/**/b.js', 'a/b.js', true], ['a/**/b.js', 'a/x/y/b.js', true], ['src/*', 'src/a/b.js', false],
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
    // test/a.test.js calls f, and a test is not source a rule about callers is asking after.
    expect(at({ where: 'callers of f' })).toEqual([]);
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

    // A unit with no nodes is markdown, YAML, or anything else the parser does not read. There is no call graph to walk, so the
    // tree is the structure it has: what it sits above, and what it sits under.
    files.set('docs/guide.md', '# guide\n');
    files.set('docs/deep/more.md', '# more\n');
    const doc = { id: 'docs/guide.md', path: 'docs/guide.md', name: 'docs/guide.md', line: 1 };
    expect(neighbourhood('calls', doc, { graph, files }).calls.map(item => item.name)).toContain('docs/deep/more.md');
    // Up is the nearest thing above, which for a file in docs/ is the root.
    expect(neighbourhood('callers', doc, { graph, files }).called_by.map(item => item.name)).toContain('README.md');
    // And it does not reach across into a directory it does not sit under.
    expect(neighbourhood('calls', doc, { graph, files }).calls.every(item => item.path.startsWith('docs/'))).toBe(true);

    // A method the graph knows walks its real edges: f calls h.
    const [id, node] = [...graph.nodes].find(([, item]) => item.qualified_name === 'f');
    const caller = { id, path: node.path, name: node.qualified_name, line: node.line, end_line: node.end_line, part: true };
    const seen = neighbourhood('calls', caller, { graph, files });
    expect(seen.calls.map(item => item.name)).toContain('h');
    // What is seen goes in the state beside the source, under a name that says what it is.
    const rule = check({ name: 't', where: 'test/**', each: 'test', sees: 'calls', ensure: 'x' }, 'perch.yaml rule 1');
    const { state } = unitStep({ rules: [rule], unit: caller, source: 'function f() { h(); }', seen });
    expect(state.calls[0]).toMatchObject({ name: expect.any(String), path: expect.any(String), source: expect.any(String) });
  });

  it('walks the call graph outward, nearest first', () => {
    // a -> b -> c -> d, so a sees b before c before d. It used to be every node in the graph whose short name appeared anywhere
    // in the text, ranked by risk score, so a method called `check` matched any file using the word and the ones kept were the
    // riskiest rather than the ones reached.
    const chain = ['a', 'b', 'c', 'd'];
    const nodes = new Map(chain.map(name => [`src/x.js::${name}`,
      { qualified_name: name, path: 'src/x.js', line: 1, end_line: 1, metrics: { risk_score: name === 'd' ? 99 : 1 } }]));
    const next = { a: ['b'], b: ['c'], c: ['d'], d: [] };
    const graph = {
      nodes,
      callees: id => (next[id.split('::')[1]] ?? []).map(name => `src/x.js::${name}`),
      callers: id => Object.entries(next).filter(([, to]) => to.includes(id.split('::')[1])).map(([from]) => `src/x.js::${from}`),
    };
    const files = new Map([['src/x.js', 'a b c d\n']]);
    const unit = { id: 'src/x.js::a', path: 'src/x.js', name: 'a', line: 1, end_line: 1, part: true };

    const seen = neighbourhood('calls', unit, { graph, files, max: 3 });
    // d carries the highest risk score and is furthest, so ranking by risk would have led with it.
    expect(seen.calls.map(item => item.name)).toEqual(['b', 'c', 'd']);
    // The cap cuts the far edge, not the near one.
    expect(neighbourhood('calls', unit, { graph, files, max: 1 }).calls.map(item => item.name)).toEqual(['b']);
    // And the same walk the other way.
    const last = { ...unit, id: 'src/x.js::d', name: 'd' };
    expect(neighbourhood('callers', last, { graph, files, max: 2 }).called_by.map(item => item.name)).toEqual(['c', 'b']);
  });

  it('asks a noul either way, and reads it as broken or as found depending on which way the rule was asked', () => {
    // The answer comes back under the rule's own name, since a rule is one entry in the same question set a scan is asked from.
    const rule = check({ name: 'r', where: '**/*', ensure: 'The comment says why.' }, 'test');
    const step = unitStep({ rules: [rule], unit: { path: 'src/a.js', name: 'f', line: 3, part: true }, source: 'function f() {}' });
    expect(step.questions.r.type).toBe('noul');
    // What is asked about is the unit's text. Where it sits in its file is not part of the question.
    expect(step.state).toEqual({ path: 'src/a.js', name: 'f', source: 'function f() {}' });
    expect(readLint(rule, { r: { noul: 0.2 } }).broken).toBeCloseTo(0.8);

    // A search asks whether the thing is here. Wanting it and not wanting it read the same answer opposite ways.
    const exist = check({ name: 'e', where: '**/*', ensure_present: 'A test that closes an issue.' }, 'test');
    const nexist = check({ name: 'n', where: '**/*', ensure_absent: 'A flag parsed and never used.' }, 'test');
    expect(unitStep({ rules: [exist], unit: { path: 'test/a.test.js', name: 'test/a.test.js', line: 1 }, source: '' }).questions.e.type).toBe('noul');
    expect(readLint(exist, { e: { noul: 0.9 } })).toMatchObject({ here: 0.9, broken: 0 });
    expect(readLint(nexist, { n: { noul: 0.9 } })).toMatchObject({ here: 0.9, broken: 0.9 });
  });

  describe('a test as a unit', () => {
    const sources = {
      'src/price.js': 'export function total(items) {\n  return items.reduce((sum, item) => sum + item, 0);\n}\n',
      // The same name in a file the test never imports.
      'src/other.js': 'export function total() {\n  return 0;\n}\n',
      'test/price.test.js': [
        "import { describe, expect, it } from 'vitest';",
        "import { total } from '../src/price.js';",
        '',
        "describe('price', () => {",
        "  it('sums the items', () => {",
        '    expect(total([1, 2])).toBe(3);',
        '  });',
        '',
        '  // An empty cart is worth nothing.',
        "  it('is zero when empty', () => {",
        '    expect(total([])).toBe(0);',
        '  });',
        '});',
      ].join('\n') + '\n',
      'tests/test_cart.py': 'from shop.cart import fetch\n\n\ndef test_fetch():\n    assert fetch(1) == 1\n',
      'src/lib.rs': [
        'pub fn positive(x: i32) -> bool {',
        '    x > 0',
        '}',
        '',
        '#[cfg(test)]',
        'mod tests {',
        '    use super::*;',
        '',
        '    #[test]',
        '    fn keeps_positive() {',
        '        assert!(positive(1));',
        '    }',
        '}',
      ].join('\n') + '\n',
    };
    const read = async text => {
      const scan = await analyzeFiles(Object.keys(text).map(path => ({ type: 'blob', path, sha: path })), { analyzer, readSource: file => text[file.path] });
      const files = new Map(Object.entries(text));
      const graph = buildGraph(scan.files);
      return { graph, files, units: selectUnits({ name: 'r', where: '**/*', each: 'test' }, { scan, graph, files, tree: [] }) };
    };

    it('takes every test case the parser marks, in any language, and ends it where its body ends', async () => {
      const { units } = await read(sources);
      expect(units.map(({ id, path, name, line, end_line, part }) => ({ id, path, name, line, end_line, part }))).toEqual([
        // The first test ends at its own closing line, not at the comment above the next one.
        { id: 'test/price.test.js::price > sums the items', path: 'test/price.test.js', name: 'price > sums the items', line: 5, end_line: 7, part: true },
        { id: 'test/price.test.js::price > is zero when empty', path: 'test/price.test.js', name: 'price > is zero when empty', line: 10, end_line: 12, part: true },
        // A pytest function and a Rust #[test] inside #[cfg(test)] are tests too. Neither is an it() or test() call.
        { id: 'tests/test_cart.py::test_fetch', path: 'tests/test_cart.py', name: 'test_fetch', line: 4, end_line: 5, part: true },
        { id: 'src/lib.rs::keeps_positive', path: 'src/lib.rs', name: 'keeps_positive', line: 10, end_line: 12, part: true },
      ]);
    });

    it('keeps a test\'s hash while another test in its file changes', async () => {
      const before = (await read(sources)).units;
      const edited = { ...sources, 'test/price.test.js': sources['test/price.test.js'].replace('toBe(0)', 'toEqual(0)') };
      const after = (await read(edited)).units;
      const hash = (units, name) => units.find(unit => unit.name === name).hash;
      expect(hash(after, 'price > sums the items')).toBe(hash(before, 'price > sums the items'));
      expect(hash(after, 'price > is zero when empty')).not.toBe(hash(before, 'price > is zero when empty'));
    });

    it('shows a test what it calls by the call graph, and not a method that only shares the name', async () => {
      const { graph, files, units } = await read(sources);
      const sums = units.find(unit => unit.name === 'price > sums the items');
      expect(neighbourhood('calls', sums, { graph, files }).calls).toEqual([
        { name: 'total', path: 'src/price.js', source: 'export function total(items) {\n  return items.reduce((sum, item) => sum + item, 0);\n}' },
      ]);
      const rust = units.find(unit => unit.name === 'keeps_positive');
      expect(neighbourhood('calls', rust, { graph, files }).calls.map(item => `${item.path}::${item.name}`)).toEqual(['src/lib.rs::positive']);
    });

    it('finds tests by what they are, with no where, and leaves them and their helpers out of a method rule', async () => {
      const text = {
        // Named nothing like a test, in no test directory: a JUnit class is a test for its @Test.
        'core/CartChecks.java': 'import org.junit.jupiter.api.Test;\nclass CartChecks {\n  @Test\n  void totals() { build(); }\n  private int build() { return 1; }\n}\n',
        'core/Cart.java': 'class Cart {\n  int total() { return 1; }\n}\n',
        'checks/cart.cpp': '#include <gtest/gtest.h>\n\nstatic int one() { return 1; }\n\nTEST(Cart, Totals) {\n  EXPECT_EQ(one(), 1);\n}\n',
        'src/lib.rs': 'pub fn positive(n: i64) -> bool {\n    n > 0\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    fn one() -> i64 {\n        1\n    }\n\n    #[test]\n    fn keeps_positive() {\n        assert!(positive(one()));\n    }\n}\n',
      };
      const scan = await analyzeFiles(Object.keys(text).map(path => ({ type: 'blob', path, sha: path })), { analyzer, readSource: file => text[file.path] });
      const files = new Map(Object.entries(text));
      const graph = buildGraph(scan.files);
      const rule = check({ name: 'tests', each: 'test', ensure: 'x' }, 'perch.yaml rule 1');
      expect(selectUnits(rule, { scan, graph, files, tree: [] }).map(unit => unit.id).sort())
        .toEqual(['checks/cart.cpp::Cart.Totals', 'core/CartChecks.java::CartChecks.totals', 'src/lib.rs::keeps_positive']);
      expect(selectUnits({ ...rule, where: 'src/**' }, { scan, graph, files, tree: [] }).map(unit => unit.id)).toEqual(['src/lib.rs::keeps_positive']);
      // A method rule reads the code: a Rust source file with its tests inside is code, and the helper in its test module is not.
      const methods = selectUnits(check({ name: 'code', where: '**/*', each: 'method', ensure: 'x' }, 'perch.yaml rule 2'), { scan, graph, files, tree: [] });
      expect(methods.map(unit => unit.id).sort()).toEqual(['core/Cart.java::Cart.total', 'src/lib.rs::positive']);
      expect(() => check({ name: 'code', each: 'method', ensure: 'x' }, 'perch.yaml rule 3')).toThrow('needs where');
    });
  });

  it('reads two tests with the same name as two tests', async () => {
    const repo = await repoWith('- name: asserts\n  where: "test/*.js"\n  each: test\n  ensure: The test asserts behavior.\n');
    await writeFile(join(repo.root, 'test', 'same.test.js'), [
      "describe('lookup', () => {",
      "  it('returns null', () => { expect(find('a')).toBeNull(); });",
      '});',
      "describe('parse', () => {",
      "  it('returns null', () => { parse(''); });",
      '});',
      "it('doesn\\'t throw on a', () => { expect(() => run('a')).not.toThrow(); });",
      "it('doesn\\'t throw on b', () => { run('b'); });",
    ].join('\n'));
    await commitAll(repo.root, 'tests that share a name');
    const calls = [];
    // A test that calls expect asserts something; the two that do not are the ones that break the rule.
    const systemOne = { ...answering(0.9), async ask(state, questions) {
      calls.push({ state, questions });
      return { model: 'scripted-jev', answers: { asserts: { type: 'noul', noul: state.source.includes('expect') ? 0.95 : 0.05 } } };
    } };
    const run = await scanRepository({ ...repo, revision: await revision(repo.root), analyzer, systemOne, paths: ['test/same.test.js'] });
    // Four tests, four questions, each over its own text: the two that share a name are told apart by what they say.
    const asked = calls.filter(call => call.questions.asserts).map(call => call.state.source);
    expect(asked).toHaveLength(4);
    expect(new Set(asked).size).toBe(4);
    expect(asked.filter(source => source.includes("it('returns null'"))).toHaveLength(2);
    expect(run.broken.map(finding => [finding.line, finding.name]).sort()).toEqual([[5, 'parse > returns null'], [8, 'doesn\'t throw on b']]);
  });

  it('asks the likeliest unit first, so a search that finds its answer stops there', () => {
    const rule = { name: 'r', kind: 'ensure_present', text: 'A test that closes an issue with a reason' };
    const units = [{ path: 'test/graph.test.js', name: 'graph' }, { path: 'test/cli.test.js', name: 'closes an issue' }, { path: 'test/scan.test.js', name: 'scan' }];
    expect(rank(rule, units)[0].name).toBe('closes an issue');
  });

  it('decides a search by the rule\'s own floor, the way a check of the same unit does', async () => {
    const repo = await repoWith('- name: no-todo\n  where: "**/*.md"\n  min: 80\n  ensure_absent: A TODO left in the text.\n'
      + '- name: says-what\n  where: "**/*.md"\n  ensure_present: A sentence saying what the project is.\n');
    // Every unit answers 60%: likelier than not, and short of the 80 the absent rule asks for.
    const run = await scanRepository({ ...repo, analyzer, systemOne: answering(0.6) });
    const checked = await checkTarget({ target: 'README.md', root: repo.root, out: repo.out, analyzer, systemOne: answering(0.6), revision: repo.revision, only: ['no-todo'] });
    expect(checked.broken).toEqual([]);
    expect(run.broken.map(finding => finding.rule)).toEqual([]);
    // --min 0 shows everything, so a unit 40% likely to lack the thing does not settle that the codebase has it.
    const everything = await scanRepository({ ...repo, analyzer, systemOne: answering(0.6), min: 0 });
    expect(everything.broken.map(finding => finding.rule).sort()).toEqual(['no-todo', 'says-what']);
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

it("shows a file's top-level code without the methods inside its span, keeping every line number", () => {
  const text = ['const limit = 10;', 'function check(value) {', '  return value < limit;', '}', 'export default check;'].join('\n');
  // The top-level unit runs from line 1 to 5 and owns lines 1 and 5; check's lines are blank in it, not dropped.
  expect(bodyOf(text, { line: 1, end_line: 5, own: [1, 5] })).toBe('const limit = 10;\n\n\n\nexport default check;');
});
