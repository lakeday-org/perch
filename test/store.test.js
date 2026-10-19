import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveCoverageReport } from '../src/coverage.js';
import { jsonChunks, jsonPieces, openStore } from '../src/store.js';

describe('JSON in pieces', () => {
  it('joins to exactly what JSON.stringify writes', () => {
    const values = [
      { a: 1, b: [1, 2, { c: [] }], d: {}, e: null, f: undefined, g: () => 1, h: 'line\nbreak', i: [undefined, null, 'x'] },
      [[[[{ deep: { deeper: [1, { deepest: true }] } }]]]],
      [], {}, 'text', 4, null, true,
      { map: new Map([[1, 2]]), when: new Date(0), nested: { list: [{ id: 'a', tests: [{ id: 't', depth: 1 }] }] } },
    ];
    for (const value of values) expect([...jsonPieces(value)].join('')).toBe(JSON.stringify(value, null, 2));
  });

  it('cuts a large value into chunks that still parse with a newline between each', () => {
    const value = { methods: Array.from({ length: 30000 }, (_, index) => ({ id: `src/m${index}.js::m`, tests: [{ id: `t${index}`, depth: 1 }], note: 'x'.repeat(40) })) };
    const chunks = [...jsonChunks(value)];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(JSON.stringify(value, null, 2));
    // How --json prints them: one stdout line each.
    expect(JSON.parse(chunks.join('\n'))).toEqual(value);
  });
});

describe('symbolic links in the results directory', () => {
  // A repository being scanned decides what is in its .perch, links included: what it points them at is outside the repository.
  const repository = async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-store-'));
    await mkdir(join(root, 'repo', '.perch'), { recursive: true });
    await writeFile(join(root, 'outside.txt'), 'keep\n');
    return { root, out: join(root, 'repo', '.perch'), outside: join(root, 'outside.txt') };
  };

  it('refuses to write the scan log through a link and leaves its target alone', async () => {
    const { out, outside } = await repository();
    await symlink(outside, join(out, 'scan.log'));
    await expect(openStore(out).startLog()).rejects.toThrow(/scan\.log is a symbolic link/);
    expect(await readFile(outside, 'utf8')).toBe('keep\n');
  });

  it('refuses to append a dismissal through a link', async () => {
    const { out, outside } = await repository();
    await symlink(outside, join(out, 'closed.jsonl'));
    await expect(openStore(out).dismiss({ id: 'f1', path: 'a.js', name: 'a', line: 1 }, 'known', ['comment'])).rejects.toThrow(/closed\.jsonl is a symbolic link/);
    expect(await readFile(outside, 'utf8')).toBe('keep\n');
  });

  it('refuses a results directory that is itself a link', async () => {
    const { root, outside } = await repository();
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), join(root, 'repo', 'linked'));
    await expect(openStore(join(root, 'repo', 'linked')).startLog()).rejects.toThrow(/linked is a symbolic link/);
    expect(await readFile(outside, 'utf8')).toBe('keep\n');
  });

  // perch coverage saves its report under reports/ and copies it to latest.jsonl, which a copy onto a link would write through.
  const report = { created_at: '2026-10-17T00:00:00.000Z', revision: 'abc1234def', files: [], methods: [], tests: [], findings: [], closed: [], failed: [] };

  it('refuses to copy the latest coverage report through a link', async () => {
    const { out, outside } = await repository();
    await mkdir(join(out, 'coverage'));
    await symlink(outside, join(out, 'coverage', 'latest.jsonl'));
    await expect(saveCoverageReport(out, report)).rejects.toThrow(/latest\.jsonl is a symbolic link/);
    expect(await readFile(outside, 'utf8')).toBe('keep\n');
  });

  it('refuses a coverage directory that is a link', async () => {
    const { root, out } = await repository();
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), join(out, 'coverage'));
    await expect(saveCoverageReport(out, report)).rejects.toThrow(/coverage is a symbolic link/);
    expect(await readdir(join(root, 'elsewhere'))).toEqual([]);
  });

  it('writes the scan log in an ordinary results directory', async () => {
    const { out } = await repository();
    const log = await openStore(out).startLog();
    await log('analyzing 1 source files');
    expect(await readFile(join(out, 'scan.log'), 'utf8')).toMatch(/analyzing 1 source files/);
  });
});
