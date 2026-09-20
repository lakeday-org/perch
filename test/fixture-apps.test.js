import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { analyzeFiles, createSourceAnalyzer, sourceFile } from '../src/analysis.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const applications = [
  ['order-service', 6, 'checkout.py', 'can_fulfil'],
  ['order-service-typescript', 4, 'src/inventory.ts', 'canFulfil'],
  ['order-service-frontend', 3, 'src/CheckoutPanel.tsx', 'canCheckout'],
  ['order-service-rust', 4, 'src/inventory.rs', 'can_fulfil'],
  ['order-service-java', 4, 'src/example/Inventory.java', 'Inventory.canFulfil'],
  ['order-service-cpp', 5, 'src/checkout.cpp', 'can_fulfil'],
];

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

it.each(applications)('analyzes the %s application without losing its buggy method or source span', async (directory, count, path, name) => {
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
});
