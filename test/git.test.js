import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { batchBlobSize, changedLines, git, listTree, readBlobs, revision } from '../src/git.js';
import { commitAll, initRepo } from './helpers.js';
import { changedPaths } from '../src/units.js';

const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

describe('changedLines', () => {
  it('lists changed lines per file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-changed-'));
    cleanups.push(root);
    const ten = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    await write(root, { 'a.js': ten, 'old name.js': ten, 'gone.js': ten, 'trim.js': ten });
    await initRepo(root);
    const base = await revision(root);
    await write(root, {
      'a.js': ten.replace('line 3\n', 'line three\n').replace('line 10\n', 'line 10\nline 11\nline 12\n'),
      'trim.js': ten.replace('line 5\n', ''),
      'caf\u00e9 \u00fc.js': 'one\ntwo\n',
    });
    await git(['mv', 'old name.js', 'new name.js'], root);
    await write(root, { 'new name.js': ten.replace('line 1\n', 'line one\n') });
    await rm(join(root, 'gone.js'));
    await commitAll(root, 'branch');
    // The main branch moves on after the branch left it; what it did is not the branch's.
    await git(['checkout', '-q', 'main'], root);
    await write(root, { 'main-only.js': 'x\n' });
    await commitAll(root, 'main moves');
    await git(['checkout', '-q', 'work'], root);
    const changed = await changedLines(root, 'main');
    expect(changed.base).toBe(base);
    expect(Object.fromEntries(changed.files)).toEqual({
      'a.js': [3, 11, 12],
      // A line taken out leaves nothing on this side to point at.
      'trim.js': [],
      'caf\u00e9 \u00fc.js': [1, 2],
      'new name.js': [1],
    });
  });
});

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

describe('changedPaths', () => {
  it('lists the files a branch changed since it left its base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-paths-'));
    cleanups.push(root);
    await write(root, { 'a.js': 'one\n', 'b.js': 'two\n' });
    await initRepo(root);
    await write(root, { 'a.js': 'one changed\n', 'c.js': 'three\n' });
    await commitAll(root, 'branch');
    // What main did after the branch left it is not the branch's.
    await git(['checkout', '-q', 'main'], root);
    await write(root, { 'b.js': 'two on main\n' });
    await commitAll(root, 'main moves');
    await git(['checkout', '-q', 'work'], root);
    expect((await changedPaths(root, 'main')).sort()).toEqual(['a.js', 'c.js']);
  });
});
