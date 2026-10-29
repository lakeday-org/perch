import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { renameImport } from '../src/treesitter/pack';

// The pack ships every platform's addon in its own package, so the Windows ones are on disk wherever the tests run.
const pack = dirname(createRequire(import.meta.url).resolve('@xberg-io/tree-sitter-language-pack'));
const imported = (pe: Buffer, name: string) => pe.includes(Buffer.from(`\0${name}\0`, 'latin1'));

it.each(['x64', 'arm64'])('renames the Windows %s addon\'s node.dll import to node.exe and nothing else', arch => {
  const original = readFileSync(join(pack, `ts-pack-core-node.win32-${arch}-msvc.node`));
  const pe = Buffer.from(original);
  const found = renameImport(pe, 'node.dll', 'node.exe');
  if (!imported(original, 'node.dll')) return expect(found).toBe(false);
  expect(found).toBe(true);
  expect(imported(pe, 'node.exe')).toBe(true);
  expect(pe.length).toBe(original.length);
  const changed = [...pe.keys()].filter(i => pe[i] !== original[i]);
  expect(changed.map(i => String.fromCharCode(pe[i])).join('')).toBe('exe');
  expect(renameImport(pe, 'node.dll', 'node.exe')).toBe(false);
});

it('leaves a file that is not a PE alone', () => {
  const elf = readFileSync(join(pack, 'ts-pack-core-node.linux-x64-gnu.node'));
  const copy = Buffer.from(elf);
  expect(renameImport(copy, 'node.dll', 'node.exe')).toBe(false);
  expect(copy.equals(elf)).toBe(true);
});
