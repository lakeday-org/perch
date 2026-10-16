import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { expectations } from './fixtures/expectations.mjs';
import { analyzeFiles, createSourceAnalyzer, sourceFile } from '../src/analysis.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
// Each application's expected.json says how many source files it has, test files included, and which method holds its
// deliberate availability bug.
const expected = await expectations();

async function sources(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (['node_modules', 'dist', 'target', 'out', '.git'].includes(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await sources(root, path));
    else if (sourceFile({ type: 'blob', path })) files.push({ type: 'blob', path });
  }
  return files;
}

it.each(expected.map(app => [app.app, app]))('analyzes the %s application without losing its buggy method or source span', async (directory, app) => {
  const { sources: count, availability: { path, name }, tests } = app;
  const root = join(fixtures, directory);
  const files = await sources(root);
  expect(files).toHaveLength(count);
  const scan = await analyzeFiles(files, { analyzer: createSourceAnalyzer(), readSource: file => readFile(join(root, file.path), 'utf8') });
  expect(scan.coverage.parsed).toBe(count);
  expect(scan.coverage.parse_failures).toBe(0);
  const file = scan.files.find(file => file.path === path);
  const method = file.methods.find(method => method.qualified_name === name);
  expect(method).toBeDefined();
  expect(method.metrics.cyclomatic_complexity).toBeGreaterThan(1);
  const source = await readFile(join(root, path), 'utf8');
  const body = source.split('\n').slice(method.line - 1, method.end_line).join('\n');
  expect(body).toMatch(/return [Tt]rue/);
  expect(body).toMatch(/return [Ff]alse/);
  expect(scan.candidates.map(candidate => candidate.id)).toContain(`${path}::${name}`);

  // The expectations in expected.json name methods by id, so every id there has to be one the parser produces, and every
  // test file has to be one the scanner keeps out of its candidates.
  expect(tests.map(test => test.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const methods = new Set(scan.files.flatMap(file => file.methods.map(method => method.id)));
  for (const id of tests.flatMap(test => [...test.direct, ...test.cuts])) expect(methods).toContain(id);
  const testPaths = new Set(tests.map(test => test.file));
  for (const testPath of testPaths) expect(scan.files.find(file => file.path === testPath)?.test).toBe(true);
  expect(scan.candidates.filter(candidate => testPaths.has(candidate.id.split('::')[0]))).toEqual([]);
});
