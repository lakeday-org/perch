import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/git.js', async original => {
  const git = await original();
  return { ...git, listTree: vi.fn(git.listTree) };
});

const { listTree, revision } = await import('../src/git.js');
const { scanRepository } = await import('../src/scan.js');
const { createSourceAnalyzer } = await import('../src/analysis.js');
const { commitAll, fixtureOptions, makeGraphFixture, scriptedSystemOne } = await import('./helpers.js');

const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function scanWith(rules) {
  const root = await makeGraphFixture();
  cleanups.push(root);
  await writeFile(join(root, 'perch.yaml'), rules);
  await commitAll(root, 'rules');
  listTree.mockClear();
  const repo = { root, revision: await revision(root), out: join(root, '.perch') };
  const run = await scanRepository(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), revision: repo.revision, systemOne: scriptedSystemOne() }));
  return { run, listed: listTree.mock.calls.length };
}

it('reads the tree only when a file rule or a search needs it', async () => {
  // Method questions carry their own source; every blob in the tree was read on every scan regardless.
  const methodsOnly = await scanWith('- name: m\n  where: "**/*.js"\n  each: method\n  ensure: Errors are returned.\n');
  expect(methodsOnly.run.status).toBe('complete');
  const withFileRule = await scanWith('- name: f\n  where: "**/*.js"\n  ensure: The file says what it is for.\n');
  // Analysis and the rule files list the tree either way; the file rule adds the one listing its units are read from.
  expect(withFileRule.listed).toBe(methodsOnly.listed + 1);
  expect(withFileRule.run.coverage.find(rule => rule.name === 'f').units).toBeGreaterThan(0);
});
