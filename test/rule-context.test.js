import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { check } from '../src/ask.js';
import { checkTarget } from '../src/check.js';
import { contextPath, unitSteps } from '../src/units.js';
import { scanRepository } from '../src/scan.js';
import { findingId, openStore } from '../src/store.js';
import { commitAll, makeGraphFixture } from './helpers.js';

const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

const put = async (root, files) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
};

/** The graph fixture, with rules and whatever other files a test needs, committed. */
async function repoWith(rules, files = {}) {
  const root = await makeGraphFixture();
  cleanups.push(root);
  await put(root, { 'perch.yaml': rules, ...files });
  await commitAll(root, 'rules');
  return { root, out: join(root, '.perch'), analyzer };
}

/** Answers every noul `value`, and keeps what each request showed and asked. */
const recording = (value = 0.9) => {
  const calls = [];
  return {
    id: 'scripted-jev', calls,
    async ask(state, questions) {
      calls.push({ state, asked: Object.keys(questions) });
      const answers = {};
      for (const [id, question] of Object.entries(questions)) {
        if (question.type === 'noul') { answers[id] = { type: 'noul', noul: value }; continue; }
        if (question.type === 'score') { answers[id] = { type: 'score', score: 1, confidence: 0.6, probabilities: Object.fromEntries(question.criteria.map((_, index) => [index, index === 1 ? 0.7 : 0.1])) }; continue; }
        const keys = Object.keys(question.criteria);
        answers[id] = { type: 'choice', choice: keys.at(-1), confidence: 0.9, probabilities: Object.fromEntries(keys.map(key => [key, key === keys.at(-1) ? 0.9 : 0.1 / (keys.length - 1)])) };
      }
      return { model: 'scripted-jev', answers, usage: { input_tokens: 10, output_tokens: 0 } };
    },
  };
};

/** Which unit each request asking `rule` was about, and the document it was shown. */
const shown = (calls, rule) => calls.filter(call => call.asked.includes(rule))
  .map(call => [call.state.name ? `${call.state.path}::${call.state.name}` : call.state.path, call.state.context?.path ?? null])
  .sort(([a], [b]) => a.localeCompare(b));

const checks = async (out, rule) => {
  const store = openStore(out);
  return (await store.readLines(store.scanPath)).filter(row => row.rule === rule).map(row => row.unit).sort();
};

const words = '- name: words\n  where: "**/*.{js,md}"\n  context: LANGUAGE.md\n  ensure: Uses the words the document says to use.\n';
const vocabularies = { 'LANGUAGE.md': 'Say order, never purchase.\n', 'src/LANGUAGE.md': 'Say invoice, never bill.\n' };

describe('the context key', () => {
  it('takes a name or a path from the root, and refuses anything else', () => {
    const rule = extra => check({ name: 'r', where: '**/*', ensure: 'x', ...extra }, 'perch.yaml rule 1');
    expect(rule({ context: 'LANGUAGE.md' }).context).toBe('LANGUAGE.md');
    expect(rule({ context: 'docs/style.md' }).context).toBe('docs/style.md');
    for (const wrong of ['../secrets.md', '/etc/passwd', 'docs/*.md', 'docs/../x.md', '', 42]) {
      expect(() => rule({ context: wrong })).toThrow('context is a file name, or a path from the repository root');
    }
    expect(() => check({ name: 'r', where: 'src/**', each: 'method', ask: 'Is it?', true: 'yes', false: 'no', context: 'X.md' }, 'perch.yaml rule 1'))
      .toThrow('context needs one of ensure, ensure_present, ensure_absent');
  });

  it('leaves the hash of a rule without one as it was', () => {
    const plain = check({ name: 'r', where: 'src/**', ensure: 'x' }, 'perch.yaml rule 1');
    const before = createHash('sha256').update(JSON.stringify([plain.ask, plain.true, plain.false, null, null, 'src/**', null, null, null, null])).digest('hex');
    expect(plain.hash).toBe(before);
    expect(check({ name: 'r', where: 'src/**', ensure: 'x', context: 'LANGUAGE.md' }, 'perch.yaml rule 1').hash).not.toBe(before);
  });

  it('finds the nearest document of a name, and a path from the root as it is', () => {
    const has = path => ['LANGUAGE.md', 'src/LANGUAGE.md'].includes(path);
    expect(contextPath('LANGUAGE.md', 'src/billing/invoice.js', has)).toBe('src/LANGUAGE.md');
    expect(contextPath('LANGUAGE.md', 'test/a.test.js', has)).toBe('LANGUAGE.md');
    expect(contextPath('LANGUAGE.md', 'README.md', has)).toBe('LANGUAGE.md');
    expect(contextPath('src/LANGUAGE.md', 'test/a.test.js', has)).toBe('src/LANGUAGE.md');
    expect(contextPath('docs/style.md', 'src/a.js', has)).toBeNull();
    expect(contextPath('STYLE.md', 'src/a.js', has)).toBeNull();
  });

  it('cuts a document too large to sit beside the unit, and says so', () => {
    const rule = check({ name: 'r', where: '**/*', ensure: 'x', context: 'LANGUAGE.md' }, 'perch.yaml rule 1');
    const unit = { id: 'src/a.js', path: 'src/a.js', name: 'src/a.js', line: 1 };
    const [step] = unitSteps({ rules: [rule], unit, source: 'export const a = 1;\n', seen: { context: { path: 'LANGUAGE.md', source: 'word '.repeat(20000) } }, budget: 4000 });
    expect(step.state.context.path).toBe('LANGUAGE.md');
    expect(step.state.context.source).toContain('cut to fit');
    expect(step.state.context.source.length).toBeLessThan(20000);
  });

  it('drops the farthest neighbours, and keeps the document, when the neighbours do not fit', () => {
    const rule = check({ name: 'r', where: 'src/**', each: 'method', ensure: 'x', context: 'LANGUAGE.md' }, 'perch.yaml rule 1');
    const unit = { id: 'src/a.js::f', path: 'src/a.js', name: 'f', line: 1, part: true };
    const neighbour = index => ({ name: `n${index}`, path: 'src/a.js', source: 'x '.repeat(500) });
    const seen = { calls: [0, 1, 2, 3, 4, 5, 6, 7].map(neighbour), called_by: [neighbour(8)], context: { path: 'LANGUAGE.md', source: 'Say order.\n' } };
    const [step] = unitSteps({ rules: [rule], unit, source: 'function f() {}\n', seen, budget: 8000 });
    expect(step.state.calls.length).toBeGreaterThan(0);
    expect(step.state.calls.length).toBeLessThan(8);
    expect(step.state.calls[0].name).toBe('n0');
    expect(step.state.context.source).toBe('Say order.\n');
  });
});

describe('a rule shown a document', () => {
  it('is shown the nearest one, and does not judge a document against itself', async () => {
    const repo = await repoWith(words, vocabularies);
    const systemOne = recording();
    await scanRepository({ ...repo, revision: await revision(repo.root), systemOne });
    expect(shown(systemOne.calls, 'words')).toEqual([
      ['src/a.js', 'src/LANGUAGE.md'],
      ['src/b.js', 'src/LANGUAGE.md'],
      ['test/a.test.js', 'LANGUAGE.md'],
    ]);
    const call = systemOne.calls.find(item => item.state.path === 'src/a.js' && item.asked.includes('words'));
    expect(call.state.context.source).toBe('Say invoice, never bill.\n');
  });

  it('asks again about the code that reads a document when a branch changes only the document', async () => {
    const repo = await repoWith(words, vocabularies);
    await scanRepository({ ...repo, revision: await revision(repo.root), systemOne: recording() });

    await writeFile(join(repo.root, 'src', 'LANGUAGE.md'), 'Say invoice, never bill or charge.\n');
    await commitAll(repo.root, 'a word more');
    const systemOne = recording();
    // What --since hands over: the files the branch changed.
    await scanRepository({ ...repo, revision: await revision(repo.root), systemOne, paths: ['src/LANGUAGE.md'] });
    expect(shown(systemOne.calls, 'words')).toEqual([['src/a.js', 'src/LANGUAGE.md'], ['src/b.js', 'src/LANGUAGE.md']]);
    // What reads the other document was not asked, and its answer is carried.
    expect(await checks(repo.out, 'words')).toEqual(['src/a.js', 'src/b.js', 'test/a.test.js']);
  });

  it('leaves out what perch.yaml ignores, though its document is in scope', async () => {
    const repo = await repoWith(`ignore:\n  - src/b.js\nrules:\n${words.replace(/^/gm, '  ').trimEnd()}\n`, vocabularies);
    const full = recording();
    await scanRepository({ ...repo, revision: await revision(repo.root), systemOne: full });
    expect(shown(full.calls, 'words').map(([unit]) => unit)).toEqual(['src/a.js', 'test/a.test.js']);

    await writeFile(join(repo.root, 'src', 'LANGUAGE.md'), 'Say invoice, never bill or charge.\n');
    await commitAll(repo.root, 'a word more');
    const since = recording();
    await scanRepository({ ...repo, revision: await revision(repo.root), systemOne: since, paths: ['src/LANGUAGE.md'] });
    expect(shown(since.calls, 'words').map(([unit]) => unit)).toEqual(['src/a.js']);
  });

  it('keeps an answer while its document stands, and drops it once the document changes or a nearer one appears', async () => {
    const repo = await repoWith(words, vocabularies);
    await scanRepository({ ...repo, revision: await revision(repo.root), systemOne: recording() });
    expect(await checks(repo.out, 'words')).toEqual(['src/a.js', 'src/b.js', 'test/a.test.js']);

    // A scan that reaches none of it carries every answer while nothing they were shown has moved.
    await scanRepository({ ...repo, revision: await revision(repo.root), systemOne: recording(), paths: ['package.json'] });
    expect(await checks(repo.out, 'words')).toEqual(['src/a.js', 'src/b.js', 'test/a.test.js']);

    await put(repo.root, { 'src/LANGUAGE.md': 'Say invoice, never bill or charge.\n', 'test/LANGUAGE.md': 'Say case, never spec.\n' });
    await commitAll(repo.root, 'reword one vocabulary, add another');
    await scanRepository({ ...repo, revision: await revision(repo.root), systemOne: recording(), paths: ['package.json'] });
    expect(await checks(repo.out, 'words')).toEqual([]);
  });

  it('asks a method rule in a request of its own, with the method\'s callers and callees', async () => {
    const repo = await repoWith('- name: words\n  where: src/b.js\n  each: method\n  context: LANGUAGE.md\n  ensure: Uses the words the document says to use.\n',
      { 'LANGUAGE.md': 'Say order, never purchase.\n' });
    const systemOne = recording();
    await scanRepository({ ...repo, revision: await revision(repo.root), systemOne });
    // perch's own questions are not shown the document, and the rule is not asked in their reading.
    expect(systemOne.calls.filter(call => call.state.method).every(call => !call.asked.includes('words') && !call.state.context)).toBe(true);
    expect(shown(systemOne.calls, 'words')).toEqual([['src/b.js::h', 'LANGUAGE.md'], ['src/b.js::k', 'LANGUAGE.md']]);
    const h = systemOne.calls.find(call => call.asked.includes('words') && call.state.name === 'h');
    expect(h.state.calls.map(item => item.name)).toContain('k');
    expect(await checks(repo.out, 'words')).toEqual(['src/b.js::h', 'src/b.js::k']);
  });

  it('keeps a finding closed on a method closed once the rule is shown a document', async () => {
    const repo = await repoWith('- name: words\n  where: src/b.js\n  each: method\n  context: LANGUAGE.md\n  ensure: x\n', { 'LANGUAGE.md': 'Say order.\n' });
    // Closed while the rule was asked in the method's reading, so under the method's own id.
    await openStore(repo.out).dismiss({ id: findingId('src/b.js::h'), method: 'src/b.js::h', path: 'src/b.js', name: 'h', line: 1 }, 'Read and decided.', ['words']);
    const run = await scanRepository({ ...repo, revision: await revision(repo.root), systemOne: recording(0.1) });
    expect(run.broken.filter(item => item.rule === 'words').map(item => item.unit)).toEqual(['src/b.js::k']);
    const listed = (await openStore(repo.out).issues(0.5)).filter(item => item.rule === 'words');
    expect(listed.map(item => [item.unit, Boolean(item.dismissed)])).toEqual([['src/b.js::k', false], ['src/b.js::h', true]]);
  });

  it('asks a method rule of every method it covers', async () => {
    const many = Array.from({ length: 401 }, (_, index) => `export function f${index}() {\n  return ${index};\n}\n`).join('\n');
    const repo = await repoWith('- name: words\n  where: src/many.js\n  each: method\n  context: LANGUAGE.md\n  ensure: x\n',
      { 'LANGUAGE.md': 'Say order.\n', 'src/many.js': many });
    const systemOne = recording();
    await scanRepository({ ...repo, revision: await revision(repo.root), systemOne, paths: ['src/many.js'] });
    expect(shown(systemOne.calls, 'words')).toHaveLength(401);
  });

  it('fails the run when a document named by its path is not there', async () => {
    const repo = await repoWith('- name: words\n  where: "src/*.js"\n  context: docs/missing.md\n  ensure: x\n');
    await expect(scanRepository({ ...repo, revision: await revision(repo.root), systemOne: recording() }))
      .rejects.toThrow('context docs/missing.md is not in this repository');
  });

  it('is shown the document on disk by perch check, committed or not', async () => {
    const repo = await repoWith('- name: words\n  where: "src/*.js"\n  context: LANGUAGE.md\n  ensure: x\n', { 'LANGUAGE.md': 'Say order, never purchase.\n' });
    await writeFile(join(repo.root, 'src', 'LANGUAGE.md'), 'Say invoice, never bill.\n');
    const systemOne = recording();
    await checkTarget({ target: 'src/a.js', root: repo.root, out: repo.out, analyzer, systemOne, revision: await revision(repo.root), only: ['words'] });
    expect(systemOne.calls.map(call => call.state.context)).toEqual([{ path: 'src/LANGUAGE.md', source: 'Say invoice, never bill.\n' }]);
  });
});
