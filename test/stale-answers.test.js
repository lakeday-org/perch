import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { analyzeTree } from '../src/analyze.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { splitStale } from '../src/context.js';
import { scanRepository } from '../src/scan.js';
import { openStore } from '../src/store.js';
import { commitAll, makeGraphFixture } from './helpers.js';

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
