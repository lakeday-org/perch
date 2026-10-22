import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compact, pullRequests } from './rerun.mjs';

const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

it('keeps where each method is and its two bug answers, and drops the rest of the reading', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perch-rerun-')); temporary.push(dir);
  const read = { type: 'read', method: 'a.js::f#2', path: 'a.js', name: 'f', line: 3, end_line: 9, root: '/home/someone/app', risk: 40, has_bug: 0.7, bug_edge_case: 0.2, kind: { choice: 'boundary' } };
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ pr: 'o_r_1-abcdef12', code: 3, seconds: 4 }));
  await fs.writeFile(path.join(dir, 'files.json'), JSON.stringify({ 'a.js': { language: 'javascript', test: false } }));
  await fs.writeFile(path.join(dir, 'scan.jsonl'), JSON.stringify({ type: 'run' }) + '\n' + JSON.stringify(read) + '\n');
  await fs.writeFile(path.join(dir, 'stdout.json'), JSON.stringify({ issues: [{ method: 'a.js::f#2' }], usage: { 'gpt-6-luna': { requests: 1, cost: 0.001 } } }));
  expect(await compact(dir)).toEqual({ pr: 'o_r_1-abcdef12', code: 3, seconds: 4, usage: { 'gpt-6-luna': { requests: 1, cost: 0.001 } }, cost: 0.001,
    reported: ['a.js::f#2'], files: { 'a.js': { language: 'javascript', test: false } },
    readings: [{ method: 'a.js::f#2', path: 'a.js', name: 'f', line: 3, end_line: 9, has_bug: 0.7, bug_edge_case: 0.2 }] });
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ pr: 'o_r_1-abcdef12', code: 'checkout', error: 'base 1234 not fetchable', seconds: 0 }));
  expect(await compact(dir)).toMatchObject({ code: 'checkout', error: 'base 1234 not fetchable', readings: [], reported: [], cost: 0 });
});

it('reruns each of the 177 pull requests the frozen run scored, once', () => {
  const prs = pullRequests();
  expect(prs).toHaveLength(177);
  expect(prs.every(item => item.base && item.head && Number.isInteger(item.number) && item.repository.startsWith('https://github.com/'))).toBe(true);
});
