import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const library = async () => {
  const { exports } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return import(new URL(`.${exports['.'].slice(1)}`, new URL('../', import.meta.url)).href);
};

it('the package exports the source analysis, built', async () => {
  const perch = await library();
  expect(Object.keys(perch).sort()).toEqual([
    'Node', 'analyzeFiles', 'buildGraph', 'createFileSelector', 'createSourceAnalyzer', 'downloading',
    'listTree', 'normalizeLanguage', 'readBlob', 'sourceFile',
  ]);
  expect(perch.normalizeLanguage('python')).toBe('python');
});
