import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { batchBlobSize, git, listTree, readBlobs } from '../src/git.js';
import { initRepo } from './helpers.js';

it('rejects Git batch headers whose blob size cannot be indexed safely', () => {
  const header = `${'a'.repeat(40)} blob `;
  expect(batchBlobSize(`${header}42`, 50)).toBe(42);
  expect(() => batchBlobSize(`${header}${Number.MAX_SAFE_INTEGER}`, 50)).toThrow('invalid blob header');
  expect(() => batchBlobSize(`${header}9007199254740992`, 50)).toThrow('invalid blob header');
  expect(() => batchBlobSize(`${header}-1`, 50)).toThrow('invalid blob header');
});

it('reads a large blob whole, joining its chunks once rather than once per chunk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perch-blobs-'));
  try {
    const big = 'x'.repeat(16 * 1024 * 1024);
    await writeFile(join(root, 'big.js'), big);
    await writeFile(join(root, 'small.js'), 'small\n');
    await initRepo(root);
    const tree = await listTree(root, (await git(['rev-parse', 'HEAD'], root)).trim());
    const shas = ['big.js', 'small.js', 'big.js'].map(path => tree.find(item => item.path === path).sha);
    const concat = vi.spyOn(Buffer, 'concat');
    const read = [];
    await readBlobs(root, shas, (index, text) => { read[index] = text.length; });
    // Sixteen megabytes arrive as a few hundred chunks. Joined as each one came, that was a few hundred copies of the blob so far.
    expect(concat.mock.calls.length).toBeLessThan(20);
    concat.mockRestore();
    expect(read).toEqual([big.length, 6, big.length]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
