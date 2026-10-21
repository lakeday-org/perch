import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { analyzeTree } from '../src/analyze.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { splitStale } from '../src/context.js';
import { scanRepository } from '../src/scan.js';
import { issuesOf } from '../src/questions.js';
import { questionSet, setHash } from '../src/ask.js';
import { openStore } from '../src/store.js';
import { commitAll, makeGraphFixture, scriptedSystemOne } from './helpers.js';

const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function repoWith(rules) {
  const root = await makeGraphFixture();
  cleanups.push(root);
  await writeFile(join(root, 'perch.yaml'), rules);
  await writeFile(join(root, 'README.md'), '# graph\n');
  await commitAll(root, 'rules');
  return { root, out: join(root, '.perch') };
}

/** Every noul answered `value(state)`, so an answer can depend on what the model was shown. */
const answering = value => ({
  id: 'scripted-jev',
  async ask(state, questions) {
    const answers = {};
    for (const [id, question] of Object.entries(questions)) {
      if (question.type === 'noul') { answers[id] = { type: 'noul', noul: value(state) }; continue; }
      if (question.type === 'score') { answers[id] = { type: 'score', score: 1, confidence: 0.6, probabilities: Object.fromEntries(question.criteria.map((_, index) => [index, index === 1 ? 0.7 : 0.1])) }; continue; }
      const keys = Object.keys(question.criteria);
      answers[id] = { type: 'choice', choice: keys.at(-1), confidence: 0.9, probabilities: Object.fromEntries(keys.map(key => [key, key === keys.at(-1) ? 0.9 : 0.1 / (keys.length - 1)])) };
    }
    return { model: 'scripted-jev', answers, usage: { input_tokens: 10, output_tokens: 0 } };
  },
});

const checks = async out => {
  const store = openStore(out);
  return (await store.readLines(store.scanPath)).filter(row => row.rule);
};

const bWith = comment => `${comment}export function h(x) {
  return k(x) * 2;
}

export function k(x) {
  return x - 1;
}
`;

describe('method answers carried by a filtered scan', () => {
  const retained = '- name: retained\n  where: src/a.js\n  each: method\n  ensure: Returns a number.\n';
  const other = '- name: other\n  where: src/b.js\n  each: method\n  ensure: Returns a number.\n';
  const defect = [{ key: 'type', value: 'defect' }];
  const skipped = [{ key: 'rule', value: 'other' }];
  const reading = async out => (await openStore(out).indexes()).latest.get('src/a.js::f');

  it.each([
    ['reworded', retained.replace('Returns a number.', 'Returns a positive number.')],
    ['deleted', ''],
    ['disabled', '- name: retained\n  disabled: true\n'],
    ['for another language', retained + '  language: python\n'],
    ['for another path', retained.replace('src/a.js', 'src/b.js')],
    ['excluding this path', retained + '  except: src/a.js\n'],
    ['about files instead', retained.replace('each: method', 'each: file')],
  ])('drops an answer when its question is %s', async (_, changed) => {
    const repo = await repoWith(retained + other);
    const options = { ...repo, revision: await revision(repo.root), analyzer };
    await scanRepository({ ...options, systemOne: scriptedSystemOne({ 'src/a.js::f': { retained: 0.1 } }) });
    expect(issuesOf(await reading(repo.out))).toContainEqual(expect.objectContaining({ label: 'retained', probability: 0.9 }));

    await writeFile(join(repo.root, 'perch.yaml'), changed + other);
    const systemOne = scriptedSystemOne();
    const run = await scanRepository({ ...options, systemOne, filters: defect });
    expect(systemOne.calls.every(call => !('retained' in call.questions))).toBe(true);
    const row = await reading(repo.out);
    expect(row).not.toHaveProperty('retained');
    expect(row.answer_hashes).not.toHaveProperty('retained');
    expect(run.visited.find(event => event.method === row.method)).not.toHaveProperty('retained');
    expect(issuesOf(row).some(issue => issue.label === 'retained')).toBe(false);
    expect((await openStore(repo.out).issues()).filter(event => event.method === row.method)
      .some(event => issuesOf(event).some(issue => issue.label === 'retained'))).toBe(false);
  });

  it('prunes answers even when the filter asks nothing about the method', async () => {
    const repo = await repoWith(retained + other);
    const options = { ...repo, revision: await revision(repo.root), analyzer };
    await scanRepository({ ...options, systemOne: scriptedSystemOne({ 'src/a.js::f': { retained: 0.1, has_bug: 0.9 } }) });
    await writeFile(join(repo.root, 'perch.yaml'), retained.replace('Returns a number.', 'Returns a positive number.') + other);
    const systemOne = scriptedSystemOne();
    const run = await scanRepository({ ...options, systemOne, filters: skipped });
    expect(run.skipped).toBe(2);
    expect(systemOne.calls.every(call => call.method.startsWith('src/b.js::'))).toBe(true);
    const row = await reading(repo.out);
    expect(row).not.toHaveProperty('retained');
    expect(row.answer_hashes).not.toHaveProperty('retained');
    expect(row.has_bug).toBe(0.9);
    expect(issuesOf(row).some(issue => issue.label === 'retained')).toBe(false);
  });

  it('drops a language-specific answer when the method changes language without changing its identity or body', async () => {
    const repo = await repoWith(retained.replace('src/a.js', 'src/value.h') + '  language: cpp\n');
    await writeFile(join(repo.root, 'src/value.h'), 'int read_value(int *p) { return *p; }\n');
    await writeFile(join(repo.root, 'src/value.cc'), 'int value() { return 1; }\n');
    await commitAll(repo.root, 'C++ header');
    const options = { ...repo, analyzer, paths: ['src/value.h'] };
    await scanRepository({ ...options, revision: await revision(repo.root), systemOne: scriptedSystemOne({ 'src/value.h::read_value': { retained: 0.1 } }) });
    const store = openStore(repo.out);
    const before = (await store.indexes()).latest.get('src/value.h::read_value');
    expect(before.retained).toBe(0.1);

    // Headers are parsed as C++ only while the repository has a C++ source file.
    await git(['rm', '-q', 'src/value.cc'], repo.root);
    await commitAll(repo.root, 'C header');
    await scanRepository({ ...options, revision: await revision(repo.root), systemOne: scriptedSystemOne(), filters: defect });
    const after = (await store.indexes()).latest.get(before.method);
    expect(after.hash).toBe(before.hash);
    expect(after).not.toHaveProperty('retained');
    expect(after.answer_hashes).not.toHaveProperty('retained');
    expect(issuesOf(after).some(issue => issue.label === 'retained')).toBe(false);
  });

  it('replaces an old answer when the changed question is asked again', async () => {
    const repo = await repoWith(retained);
    const options = { ...repo, revision: await revision(repo.root), analyzer };
    await scanRepository({ ...options, systemOne: scriptedSystemOne({ 'src/a.js::f': { retained: 0.1 } }) });
    const before = await reading(repo.out);
    await writeFile(join(repo.root, 'perch.yaml'), retained.replace('Returns a number.', 'Returns a positive number.'));
    await scanRepository({ ...options, systemOne: scriptedSystemOne({ 'src/a.js::f': { retained: 0.9 } }), filters: [{ key: 'rule', value: 'retained' }] });
    const after = await reading(repo.out);
    expect(after.retained).toBe(0.9);
    expect(after.answer_hashes.retained).not.toBe(before.answer_hashes.retained);
    expect(issuesOf(after).some(issue => issue.label === 'retained')).toBe(false);
    expect(after.has_bug).toBe(before.has_bug);
    expect(after.kind).toEqual(before.kind);
    expect(after.severity).toEqual(before.severity);
  });

  it('keeps unchanged unasked answers and their fingerprints across successive filtered scans', async () => {
    const repo = await repoWith(retained + other);
    const options = { ...repo, revision: await revision(repo.root), analyzer };
    await scanRepository({ ...options, systemOne: scriptedSystemOne({ 'src/a.js::f': { retained: 0.1, has_bug: 0.9 } }) });
    const before = await reading(repo.out);
    for (const filters of [defect, [{ key: 'type', value: 'security' }], [{ key: 'type', value: 'docs' }], skipped, defect]) {
      const systemOne = scriptedSystemOne();
      await scanRepository({ ...options, systemOne, filters });
      expect(systemOne.calls.every(call => !('retained' in call.questions))).toBe(true);
      const row = await reading(repo.out);
      expect(row.retained).toBe(0.1);
      expect(row.answer_hashes.retained).toBe(before.answer_hashes.retained);
      expect(row.answers_set).toBe(setHash(questionSet().filter(question => row.answer_hashes[question.name] === question.hash)));
      expect(row.kind).toEqual(before.kind);
      expect(row.severity).toEqual(before.severity);
      expect(issuesOf(row)).toContainEqual(expect.objectContaining({ label: 'retained', probability: 0.9 }));
    }
  });

  it.each([['reading', defect], ['skipping', skipped]])('discards legacy answers without fingerprints when %s the method', async (_, filters) => {
    const repo = await repoWith(retained + other);
    const options = { ...repo, revision: await revision(repo.root), analyzer };
    await scanRepository({ ...options, systemOne: scriptedSystemOne({ 'src/a.js::f': { retained: 0.1 } }) });
    const store = openStore(repo.out);
    const rows = await store.readLines(store.scanPath);
    for (const row of rows) delete row.answer_hashes;
    await store.recordScan(rows);

    await scanRepository({ ...options, systemOne: scriptedSystemOne(), filters });
    expect(await reading(repo.out)).not.toHaveProperty('retained');
    expect((await store.issues()).some(event => issuesOf(event).some(issue => issue.label === 'retained'))).toBe(false);
  });
});

describe('an answer about text the model was shown', () => {
  it('is stale once the comment above a method changes, since the comment was part of the question', async () => {
    const repo = await repoWith('- name: legacy\n  where: "src/b.js"\n  each: method\n  ensure_absent: A branch kept for an old format.\n');
    await writeFile(join(repo.root, 'src', 'b.js'), bWith('// Falls back to the legacy format.\n'));
    await commitAll(repo.root, 'comment');
    const before = await revision(repo.root);
    const saysLegacy = answering(state => (String(state.source ?? '').includes('legacy') ? 0.95 : 0.05));
    await scanRepository({ ...repo, revision: before, analyzer, systemOne: saysLegacy });
    expect((await checks(repo.out)).map(row => [row.unit, row.broken])).toEqual([['src/b.js::h', 1]]);

    // Only the comment goes. The body is untouched, and it was the comment the answer was about.
    await writeFile(join(repo.root, 'src', 'b.js'), bWith(''));
    await commitAll(repo.root, 'drop the comment');
    const after = await revision(repo.root);
    const scanBefore = await analyzeTree({ ...repo, revision: before, analyzer });
    const scanAfter = await analyzeTree({ ...repo, revision: after, analyzer });
    const hashOf = scan => scan.files.find(file => file.path === 'src/b.js').methods.find(method => method.name === 'h').hash;
    expect(hashOf(scanAfter)).not.toBe(hashOf(scanBefore));

    // perch issues at the new HEAD, before anything is scanned again: the answer is about a comment that is gone.
    const listed = splitStale(await openStore(repo.out).issues(0.5, { scan: scanAfter, all: true }), scanAfter);
    expect(listed.current.filter(finding => finding.rule === 'legacy')).toEqual([]);

    // A scan that does not reach src/b.js carries earlier checks forward, and must not carry this one.
    await scanRepository({ ...repo, revision: after, analyzer, systemOne: saysLegacy, paths: ['README.md'] });
    expect(await checks(repo.out)).toEqual([]);
  });
});

describe('a check on a unit that is gone', () => {
  it('is dropped when the test it was about is deleted or moved to another file', async () => {
    const repo = await repoWith('- name: asserts\n  where: "test/*.js"\n  each: test\n  ensure: The test asserts behavior.\n');
    await writeFile(join(repo.root, 'test', 'a.test.js'), `import test from 'node:test';
import { f } from '../src/a.js';

test('f', () => { f(1); });

test('f again', () => { f(2); });
`);
    await commitAll(repo.root, 'two tests');
    const broken = answering(() => 0.1);
    await scanRepository({ ...repo, revision: await revision(repo.root), analyzer, systemOne: broken });
    expect((await checks(repo.out)).map(row => row.unit).sort()).toEqual(['test/a.test.js::f', 'test/a.test.js::f again']);

    await writeFile(join(repo.root, 'test', 'a.test.js'), `import test from 'node:test';
import { f } from '../src/a.js';

test('f', () => { f(1); });
`);
    await writeFile(join(repo.root, 'test', 'b.test.js'), `import test from 'node:test';
import { f } from '../src/a.js';

test('f again', () => { f(2); });
`);
    await commitAll(repo.root, 'move a test');
    // What --since hands over: the files the branch changed.
    await scanRepository({ ...repo, revision: await revision(repo.root), analyzer, systemOne: broken, paths: ['test/a.test.js', 'test/b.test.js'] });
    expect((await checks(repo.out)).map(row => row.unit).sort()).toEqual(['test/a.test.js::f', 'test/b.test.js::f again']);
  });

  it('is dropped when the test was deleted and nothing asked about its file again', async () => {
    const repo = await repoWith('- name: asserts\n  where: "test/*.js"\n  each: test\n  ensure: The test asserts behavior.\n');
    const broken = answering(() => 0.1);
    await scanRepository({ ...repo, revision: await revision(repo.root), analyzer, systemOne: broken });
    expect((await checks(repo.out)).map(row => row.unit)).toEqual(['test/a.test.js::f']);

    await git(['rm', '-q', 'test/a.test.js'], repo.root);
    await commitAll(repo.root, 'delete the test');
    await scanRepository({ ...repo, revision: await revision(repo.root), analyzer, systemOne: broken, paths: ['README.md'] });
    expect(await checks(repo.out)).toEqual([]);
  });

  it('is dropped when the file it was about is deleted', async () => {
    const repo = await repoWith('- name: prose\n  where: "**/*.md"\n  ensure: A person wrote this.\n');
    await writeFile(join(repo.root, 'NOTES.md'), '# notes\n');
    await commitAll(repo.root, 'notes');
    const broken = answering(() => 0.1);
    await scanRepository({ ...repo, revision: await revision(repo.root), analyzer, systemOne: broken });
    expect((await checks(repo.out)).map(row => row.unit).sort()).toEqual(['NOTES.md', 'README.md']);

    await git(['rm', '-q', 'NOTES.md'], repo.root);
    await commitAll(repo.root, 'delete the notes');
    await scanRepository({ ...repo, revision: await revision(repo.root), analyzer, systemOne: broken, paths: ['NOTES.md'] });
    expect((await checks(repo.out)).map(row => row.unit)).toEqual(['README.md']);
  });
});
