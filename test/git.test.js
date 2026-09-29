import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { batchBlobSize, git, listTree, readBlobs } from '../src/git.js';
import { initRepo } from './helpers.js';

it('rejects Git batch headers whose blob size cannot be indexed safely', () => {
  const header = `${'a'.repeat(40)} blob `;
  expect(batchBlobSize(`${header}42`, 50)).toBe(42);
  expect(() => batchBlobSize(`${header}${Number.MAX_SAFE_INTEGER}`, 50)).toThrow('invalid blob header');
  expect(() => batchBlobSize(`${header}9007199254740992`, 50)).toThrow('invalid blob header');
  expect(() => batchBlobSize(`${header}-1`, 50)).toThrow('invalid blob header');
});

it('reads a large blob whole, in time proportional to its size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perch-blobs-'));
  try {
    const big = 'x'.repeat(64 * 1024 * 1024);
    await writeFile(join(root, 'big.js'), big);
    await writeFile(join(root, 'small.js'), 'small\n');
    await initRepo(root);
    const tree = await listTree(root, (await git(['rev-parse', 'HEAD'], root)).trim());
    const shas = ['big.js', 'small.js'].map(path => tree.find(item => item.path === path).sha);
    const read = [];
    const started = performance.now();
    await readBlobs(root, shas, (index, text) => { read[index] = text; });
    // Joining every chunk onto what came before copied the blob once per chunk: three seconds here for 64 MB.
    expect(performance.now() - started).toBeLessThan(1500);
    expect(read.map(text => text.length)).toEqual([big.length, 6]);
    expect(read[0] === big && read[1] === 'small\n').toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);
