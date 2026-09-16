import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openJournal } from '../src/journal.js';

const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('journal', () => {
  it('memoizes by key, rejects identity changes, and survives reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-journal-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'journal.json');
    const journal = await openJournal(path);
    let runs = 0;
    const fn = async () => { runs++; return { answer: 42 }; };
    expect(await journal.memo('triage-0', 'abc', fn)).toEqual({ answer: 42 });
    expect(await journal.memo('triage-0', 'abc', fn)).toEqual({ answer: 42 });
    expect(runs).toBe(1);
    await expect(journal.memo('triage-0', 'other', fn)).rejects.toThrow('triage-0 identity changed');
    expect(runs).toBe(1);

    const reloaded = await openJournal(path);
    expect(reloaded.has('triage-0')).toBe(true);
    expect(await reloaded.memo('triage-0', 'abc', fn)).toEqual({ answer: 42 });
    expect(runs).toBe(1);
    expect(await reloaded.memo('command:x', 'id', async () => 'ran')).toBe('ran');
    expect((await openJournal(path)).get('command:x')).toBe('ran');
    // Atomic writes leave no temporary files behind.
    expect(await readdir(join(dir, 'nested'))).toEqual(['journal.json']);
  });

  it('does not store a value when fn throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-journal-'));
    dirs.push(dir);
    const journal = await openJournal(join(dir, 'journal.json'));
    await expect(journal.memo('fix-0-0', 'id', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(journal.has('fix-0-0')).toBe(false);
    expect(await journal.memo('fix-0-0', 'id', async () => 'second')).toBe('second');
  });
});
