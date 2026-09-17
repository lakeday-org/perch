import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { lintRepository, lintStep, matches, readLint, readRules, selectUnits, testTitles } from '../src/lint.js';
import { formatLint, lintLine } from '../src/report.js';
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
    await expect(readRules(missing.root, missing.revision)).rejects.toThrow('needs where or over to say what it applies to');
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
    expect(at({ over: 'callers of h' }).map(unit => unit.name)).toEqual(['f']);
    expect(() => at({ over: 'callers of nosuchmethod' })).toThrow('no method named nosuchmethod');
    // mentions is text, and says so: it finds the methods worth asking about.
    expect(at({ over: 'mentions x - 1' }).map(unit => unit.name)).toEqual(['k']);
  });

  it('asks a noul for ensure and a choice for behaviour, and reads the answer as how sure it is broken', () => {
    const rule = { name: 'r', kind: 'ensure', ensure: 'The comment says why.' };
    const step = lintStep({ rule, unit: { path: 'src/a.js', name: 'f', line: 3, method: true }, source: 'function f() {}' });
    expect(step.question.holds.type).toBe('noul');
    expect(step.state).toMatchObject({ rule: 'r', path: 'src/a.js', method: 'f', line: 3 });
    expect(readLint(rule, { holds: { noul: 0.2 } }).broken).toBeCloseTo(0.8);

    const behaviour = { name: 'b', kind: 'behaviour', behaviour: 'An issue can be closed.' };
    const cited = lintStep({ rule: behaviour, unit: { path: 'test/a.test.js', name: 'test/a.test.js', line: 1 }, source: '', titles: ['closes an issue'] });
    expect(cited.question.cite.type).toBe('choice');
    // The answer has to be a test you can open, or none. "Yes it is tested" is not an answer.
    expect(Object.keys(cited.question.cite.criteria)).toEqual(['closes an issue', 'none']);
    expect(readLint(behaviour, { cite: { choice: 'closes an issue', probabilities: { 'closes an issue': 0.9, none: 0.1 } } })).toEqual({ broken: expect.closeTo(0.1), cite: 'closes an issue' });
    expect(readLint(behaviour, { cite: { choice: 'none', probabilities: { none: 0.8 } } })).toEqual({ broken: 0.8, cite: null });
  });

  it('finds test titles to cite', () => {
    expect(testTitles("it('closes an issue', async () => {\n  test.skip('other', () => {})\n  it.each([1])('t %i', () => {})\n")).toEqual(['closes an issue', 'other', 't %i']);
  });

  it('reports what broke, exits on it, and does not ask twice about unchanged code', async () => {
    const repo = await repoWith('- name: comment-says-why\n  where: "src/*.js"\n  each: method\n  ensure: "The comment says why."\n');
    const calls = [];
    const options = { ...repo, analyzer, systemOne: answering(0.1, calls) };

    const seen = [];
    const run = await lintRepository({ ...options, onFinding: finding => seen.push(finding) });
    expect(run.rules.map(rule => rule.name)).toEqual(['comment-says-why']);
    expect(run.checked).toBe(4);
    expect(run.asked).toBe(4);
    expect(run.findings).toHaveLength(4);
    expect(run.findings[0].broken).toBeCloseTo(0.9);

    // Findings are handed over as they are answered, in file order, so a run reads like a linter rather than arriving at the end.
    expect(seen).toHaveLength(4);
    expect(seen.map(finding => finding.path)).toEqual(['src/a.js', 'src/a.js', 'src/b.js', 'src/b.js']);
    expect(lintLine(seen[0])).toMatch(/^ +\d+ +90% {2}comment-says-why {2}f$/);

    // The report is the count and what the rules that fired actually demand; the rows have already been said.
    const shown = formatLint(run, { width: 100 });
    expect(shown).toContain('4 problems in 2 files');
    expect(shown).toContain('comment-says-why  The comment says why.');
    expect(shown).toContain('how sure the model is that the rule is broken');
    expect(shown).not.toMatch(/^src\/a\.js$/m);

    // Asked once. The same code under the same rule is read from the log.
    const held = [];
    const again = await lintRepository({ ...options, systemOne: answering(0.1), onFinding: finding => held.push(finding) });
    // A cached finding is still reported: it was found before this run, not in it.
    expect(held).toHaveLength(4);
    expect(again.asked).toBe(0);
    expect(again.skipped).toBe(4);
    expect(again.findings).toHaveLength(4);

    // Editing the rule's wording is a different question, so it is asked again.
    await writeFile(join(repo.root, 'perch.yaml'), '- name: comment-says-why\n  where: "src/*.js"\n  each: method\n  ensure: "The comment says why, and names the caller."\n');
    await commitAll(repo.root, 'tighten the rule');
    const tightened = await lintRepository({ ...options, revision: await revision(repo.root), systemOne: answering(0.9) });
    expect(tightened.asked).toBe(4);
    expect(tightened.findings).toHaveLength(0);
    expect(formatLint(tightened)).toBe('1 rule, 4 checked, no problems');
  });

  it('asks only about what a branch changed', async () => {
    const repo = await repoWith('- name: prose\n  where: "**/*.md"\n  ensure: "A person wrote this."\n');
    await mkdir(join(repo.root, 'doc'), { recursive: true });
    await writeFile(join(repo.root, 'doc', 'one.md'), '# one\n');
    await writeFile(join(repo.root, 'doc', 'two.md'), '# two\n');
    await commitAll(repo.root, 'docs');
    const at = await revision(repo.root);

    const everything = await lintRepository({ ...repo, revision: at, analyzer, systemOne: answering(0.9) });
    expect(everything.checked).toBe(3);
    const narrowed = await lintRepository({ ...repo, revision: at, analyzer, systemOne: answering(0.9), paths: ['doc/one.md'], force: true });
    expect(narrowed.checked).toBe(1);
    expect(narrowed.findings).toHaveLength(0);
  });
});
