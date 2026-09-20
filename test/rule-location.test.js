import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BUILTIN, installQuestions, questionSet } from '../src/ask.js';
import { git, revision } from '../src/git.js';
import { openStore } from '../src/store.js';
import { readRules, selectUnits } from '../src/units.js';
import { initRepo } from './helpers.js';

const roots = [];
afterEach(async () => {
  installQuestions(BUILTIN);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const rule = (name, text = name) => `- name: ${name}\n  where: src/**/*.js\n  ensure: ${text}\n`;
async function put(root, path, text) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), text);
}
async function repository(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'perch-rule-location-'));
  roots.push(root);
  await put(root, 'src/app.js', 'export function app() { return true; }\n');
  for (const [path, text] of Object.entries(files)) await put(root, path, text);
  await initRepo(root);
  return root;
}

it('loads committed and uncommitted split rules with disk edits and stable override order', async () => {
  const root = await repository({
    'perch.yaml': rule('shared', 'Root definition.'),
    '.perch/rules/a.yaml': rule('shared', 'First split definition.'),
    '.perch/rules/nested/b.yml': rule('committed'),
    'perch/old.yaml': rule('old-location'),
  });
  const rev = await revision(root);
  await put(root, '.perch/rules/a.yaml', rule('shared', 'Edited split definition.'));
  await put(root, '.perch/rules/z.yaml', rule('shared', 'Last split definition.'));
  await put(root, '.perch/rules/nested/new.yml', rule('uncommitted'));
  await put(root, '.perch/rules/notes.txt', 'not a rule');
  const rules = await readRules(root, rev);
  expect(rules.map(item => item.name)).toEqual(['shared', 'shared', 'committed', 'uncommitted', 'shared']);
  expect(rules[1].text).toBe('Edited split definition.');
  expect(questionSet().find(item => item.name === 'shared').text).toBe('Last split definition.');
  // A scan can still load a committed rule when no working-copy file exists.
  await rm(join(root, '.perch/rules/nested/b.yml'));
  expect((await readRules(root, rev)).find(item => item.name === 'committed').at).toContain('.perch/rules/nested/b.yml');
});

it('loads split rules without a root rule file and reports malformed YAML', async () => {
  const root = await repository({ '.perch/rules/only.yml': rule('only') });
  const rev = await revision(root);
  expect((await readRules(root, rev)).map(item => item.name)).toEqual(['only']);
  await put(root, '.perch/rules/broken.yaml', '- name: broken\n  where: [\n');
  await expect(readRules(root, rev)).rejects.toThrow();
});

it('keeps rule definitions out of file-rule targets', () => {
  const paths = ['perch.yaml', '.perch/rules/one.yaml', '.perch/rules/nested/two.yml', 'src/app.js'];
  const tree = paths.map(path => ({ path, type: 'blob', sha: path, size: 20 }));
  expect(selectUnits({ where: '**/*', each: 'file' }, { tree }).map(unit => unit.path)).toEqual(['src/app.js']);
});

it('upgrades the generated ignore file so Git tracks nested rules and closures but no cache output', async () => {
  const root = await repository();
  await put(root, '.gitignore', await readFile(new URL('../.gitignore', import.meta.url), 'utf8'));
  await put(root, '.perch/.gitignore', '# Written by perch. Results are a cache; closures are not.\n*\n!closed.jsonl\n');
  const files = {
    '.perch/rules/one.yaml': rule('one'),
    '.perch/rules/nested/two.yml': rule('two'),
    '.perch/closed.jsonl': '',
    '.perch/scan.jsonl': '',
    '.perch/runs/one/run.json': '{}',
    '.perch/scan.log': '',
  };
  for (const [path, text] of Object.entries(files)) await put(root, path, text);
  const store = openStore(join(root, '.perch'));
  await store.exclude(root);
  const visible = (await git(['ls-files', '--others', '--exclude-standard'], root)).trim().split('\n');
  expect(visible.filter(path => path.startsWith('.perch/'))).toEqual([
    '.perch/closed.jsonl', '.perch/rules/nested/two.yml', '.perch/rules/one.yaml',
  ]);
  await git(['add', '.perch/rules', '.perch/closed.jsonl'], root);
  const staged = (await git(['diff', '--cached', '--name-only'], root)).trim().split('\n');
  expect(staged).toEqual(['.perch/closed.jsonl', '.perch/rules/nested/two.yml', '.perch/rules/one.yaml']);
  const ignored = await readFile(join(root, '.perch/.gitignore'), 'utf8');
  await store.exclude(root);
  expect(await readFile(join(root, '.perch/.gitignore'), 'utf8')).toBe(ignored);
});

it('keeps custom output caches ignored while rules stay under the repository root', async () => {
  const root = await repository({ '.perch/rules/one.yaml': rule('one') });
  const out = join(root, 'results');
  await put(root, 'results/rules/cache.yaml', 'cached output');
  await put(root, 'results/closed.jsonl', '');
  await openStore(out).exclude(root);
  const visible = (await git(['ls-files', '--others', '--exclude-standard'], root)).trim().split('\n');
  expect(visible.filter(path => path.startsWith('results/'))).toEqual(['results/closed.jsonl']);
  expect((await readRules(root, await revision(root))).map(item => item.name)).toEqual(['one']);
});
