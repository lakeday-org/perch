import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { lintRepository, lintStep, matches, rank, readLint, readRules, selectUnits, testBlocks } from '../src/lint.js';
import { formatLint, formatLintFile } from '../src/report.js';
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

/** Answers every question the same way: how sure the rule holds, or which test to cite. */
const answering = (value, calls = []) => ({
  id: 'scripted-jev', calls,
  async ask(state, questions) {
    calls.push({ state, questions });
    const [id, question] = Object.entries(questions)[0];
    if (question.type === 'noul') return { model: 'scripted-jev', answers: { [id]: { type: 'noul', noul: value } }, usage: { input_tokens: 10, output_tokens: 0 } };
    const keys = Object.keys(question.criteria);
    const choice = keys.includes(value) ? value : keys.at(-1);
    return { model: 'scripted-jev', answers: { [id]: { type: 'choice', choice, confidence: 0.9, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 0.9 : 0.1 / (keys.length - 1)])) } }, usage: { input_tokens: 10, output_tokens: 0 } };
  },
});

describe('perch lint', () => {
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
    const { analyzeTree } = await import('../src/scan.js');
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

  it('asks a noul either way, and reads it as broken or as found depending on which way the rule was asked', () => {
    const rule = { name: 'r', kind: 'ensure', text: 'The comment says why.' };
    const step = lintStep({ rule, unit: { path: 'src/a.js', name: 'f', line: 3, part: true }, source: 'function f() {}' });
    expect(step.question.holds.type).toBe('noul');
    expect(step.state).toMatchObject({ rule: 'r', path: 'src/a.js', name: 'f', line: 3 });
    expect(readLint(rule, { holds: { noul: 0.2 } }).broken).toBeCloseTo(0.8);

    // A search asks whether the thing is here. Wanting it and not wanting it read the same answer opposite ways.
    const exist = { name: 'e', kind: 'ensure_exist', text: 'A test that closes an issue.' };
    const nexist = { name: 'n', kind: 'ensure_nexist', text: 'A flag parsed and never used.' };
    expect(lintStep({ rule: exist, unit: { path: 'test/a.test.js', name: 'test/a.test.js', line: 1 }, source: '' }).question.found.type).toBe('noul');
    expect(readLint(exist, { found: { noul: 0.9 } })).toMatchObject({ here: 0.9, broken: 0 });
    expect(readLint(nexist, { found: { noul: 0.9 } })).toMatchObject({ here: 0.9, broken: 0.9 });
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
    const rule = { name: 'r', kind: 'ensure_exist', text: 'A test that closes an issue with a reason' };
    const units = [{ path: 'test/graph.test.js', name: 'graph' }, { path: 'test/cli.test.js', name: 'closes an issue' }, { path: 'test/scan.test.js', name: 'scan' }];
    expect(rank(rule, units)[0].name).toBe('closes an issue');
  });

  it('reports what broke, exits on it, and does not ask twice about unchanged code', async () => {
    const repo = await repoWith('- name: comment-says-why\n  where: "src/*.js"\n  each: method\n  ensure: "The comment says why."\n');
    const calls = [];
    const options = { ...repo, analyzer, systemOne: answering(0.1, calls) };

    const seen = [];
    const run = await lintRepository({ ...options, onFile: file => seen.push(file) });
    expect(run.rules.map(rule => rule.name)).toEqual(['comment-says-why']);
    expect(run.checked).toBe(4);
    expect(run.asked).toBe(4);
    expect(run.findings).toHaveLength(4);
    expect(run.findings[0].broken).toBeCloseTo(0.9);

    // A file is handed over once every rule has been asked of every part of it, so a run reads like a linter.
    expect(seen.map(file => file.path)).toEqual(['src/a.js', 'src/b.js']);
    expect(seen[0]).toMatchObject({ checked: 2, findings: [{ name: 'f' }, { name: 'g' }] });
    // The percentage is the share that passed, so a clean file reads 100% like every other tool in a build.
    // Grouped by rule, with the rule's own sentence over its findings: a typed answer carries no message of its own.
    const block = formatLintFile(seen[0]);
    expect(block).toMatch(/^src\/a\.js {2}0% {2}0 of 2 checks passed$/m);
    expect(block).toMatch(/^ {2}\d+ {2}comment-says-why {2}f$/m);
    expect(formatLintFile({ path: 'src/c.js', checked: 4, findings: [] })).toBe('src/c.js  100%  4 of 4 checks passed');

    // The summary counts them; the files already said what each rule wanted.
    const shown = formatLint(run);
    expect(shown).toContain('0%  0 of 4 checks passed. 4 failed in 2 files.');
    // The rules that fired are spelled out once, in a table, rather than over every file they touched.
    expect(shown).toMatch(/^ +Failed {2}Rule +What it asks$/m);
    expect(shown).toMatch(/^ +4 {2}comment-says-why {2}The comment says why\.$/m);

    // Asked once. The same code under the same rule is read from the log.
    const held = [];
    const again = await lintRepository({ ...options, systemOne: answering(0.1), onFile: file => held.push(file) });
    // A cached answer is still reported: it was found before this run, not in it.
    expect(held.flatMap(file => file.findings)).toHaveLength(4);
    expect(again.asked).toBe(0);
    expect(again.skipped).toBe(4);
    expect(again.findings).toHaveLength(4);

    // Editing the rule's wording is a different question, so it is asked again.
    await writeFile(join(repo.root, 'perch.yaml'), '- name: comment-says-why\n  where: "src/*.js"\n  each: method\n  ensure: "The comment says why, and names the caller."\n');
    await commitAll(repo.root, 'tighten the rule');
    const tightened = await lintRepository({ ...options, revision: await revision(repo.root), systemOne: answering(0.9) });
    expect(tightened.asked).toBe(4);
    expect(tightened.findings).toHaveLength(0);
    expect(formatLint(tightened)).toBe('1 rule, 4 checks, all passed.');
  });

  it('asks only about what a branch changed', async () => {
    const repo = await repoWith('- name: prose\n  where: "**/*.md"\n  ensure: "A person wrote this."\n');
    await mkdir(join(repo.root, 'doc'), { recursive: true });
    await writeFile(join(repo.root, 'doc', 'one.md'), '# one\n');
    await writeFile(join(repo.root, 'doc', 'two.md'), '# two\n');
    await commitAll(repo.root, 'docs');
    const at = await revision(repo.root);

    // Nothing on record yet, so a narrowed run asks about the one file and says the other two were never checked.
    const first = await lintRepository({ ...repo, revision: at, analyzer, systemOne: answering(0.1), paths: ['doc/one.md'] });
    expect(first).toMatchObject({ asked: 1, unchecked: 2 });
    expect(formatLint(first)).toContain('2 never checked');

    // Now the rest is answered, a narrowed run asks about that file alone and still reports what the others said.
    await lintRepository({ ...repo, revision: at, analyzer, systemOne: answering(0.1) });
    const narrowed = await lintRepository({ ...repo, revision: at, analyzer, systemOne: answering(0.1), paths: ['doc/one.md'] });
    expect(narrowed).toMatchObject({ asked: 0, unchecked: 0, skipped: 3 });
    expect(narrowed.findings.map(finding => finding.path).sort()).toEqual(['README.md', 'doc/one.md', 'doc/two.md']);
  });
});
