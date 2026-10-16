/**
 * The deterministic half of perch coverage against the six fixture applications: which tests the parser finds, what each one
 * reaches directly, what its mocks cut, and what kinds of I/O it makes. The expectations are
 * test/fixtures/<app>/expected.json, written by reading the fixtures. What Jev says about each test is checked live by
 * scripts/verify-coverage.mjs, not here.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { expectations } from './fixtures/expectations.mjs';
import { analyzeFiles, createSourceAnalyzer, sourceFile } from '../src/analysis.js';
import { buildGraph } from '../src/graph.js';
import { computeCoverage } from '../src/coverage.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const expected = await expectations();

async function sources(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (['node_modules', 'dist', 'target', 'out', '.git', '.perch'].includes(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await sources(root, path));
    else if (sourceFile({ type: 'blob', path })) files.push({ type: 'blob', path });
  }
  return files;
}

it.each(expected.map(app => [app.app, app]))('finds the twelve tests in %s and what each one reaches', async (_, app) => {
  const root = join(fixtures, app.app);
  const scan = await analyzeFiles(await sources(root), { analyzer: createSourceAnalyzer(), readSource: file => readFile(join(root, file.path), 'utf8') });
  const coverage = computeCoverage({ scan, graph: buildGraph(scan.files) });
  expect(coverage.failed).toEqual([]);
  expect(coverage.tests).toHaveLength(app.tests.length);
  for (const want of app.tests) {
    const test = coverage.tests.find(item => item.node.path === want.file && item.node.case.name === want.name);
    expect(test, `${app.app} #${want.n} ${want.name}`).toBeDefined();
    const at = `${app.app} #${want.n} ${want.name}`;
    expect(test.direct, `${at}: direct`).toEqual([...want.direct].sort());
    expect(test.cuts, `${at}: cuts`).toEqual([...want.cuts].sort());
    expect(test.touches, `${at}: touches`).toEqual([...want.touches].sort());
  }
});
