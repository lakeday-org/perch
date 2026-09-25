import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openStore, writeJson } from '../src/store.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'perch-checkpoint-')); roots.push(root);
  const store = openStore(root);
  const run = { id: 'test', status: 'running', calls: 0, visited: [], broken: [], failed: [] };
  return { store, run, path: join(store.runDir(run.id), 'run.json') };
}

it('removes temporary result files when replacement fails', async () => {
  const { store } = await fixture();
  await mkdir(store.scanPath);
  await mkdir(join(store.out, 'state.json'));

  await expect(store.recordScan([{ id: 'finding' }])).rejects.toThrow();
  await expect(writeJson(join(store.out, 'state.json'), { ready: true })).rejects.toThrow();
  expect((await readdir(store.out)).sort()).toEqual(['scan.jsonl', 'state.json']);
});

it('keeps the newest runs, so a run another scan is still writing survives this one finishing', async () => {
  const { store } = await fixture();
  const names = Array.from({ length: 14 }, (_, index) => `run-${String(index).padStart(2, '0')}`);
  for (const [index, name] of names.entries()) {
    await mkdir(store.runDir(name), { recursive: true });
    const when = new Date(Date.now() - (names.length - index) * 60_000);
    await utimes(store.runDir(name), when, when);
  }
  // The finishing run is the oldest folder here: a scan that started first and ended last is still the one that must stay.
  await store.prune('runs', 'run-00');
  expect((await readdir(join(store.out, 'runs'))).sort()).toEqual(['run-00', ...names.slice(-9)]);
});

it('persists each answer once while progress and all results remain readable', async () => {
  const { store, run, path } = await fixture();
  const save = await store.startRun(run);
  let serializations = 0;
  for (let batch = 0; batch < 40; batch++) {
    for (let item = 0; item < 8; item++) run.visited.push({
      method: `${batch}/${item}`, get answer() { serializations++; return 'x'.repeat(1000); },
    });
    run.calls += 8;
    run.broken.push({ rule: 'r', path: `${batch}.js` });
    run.failed.push({ error: `${batch}` });
    await save();
    const current = await store.latestRun();
    expect(current.calls).toBe(run.calls);
    expect(current.visited).toHaveLength(run.calls);
    expect(current.visited.at(-1).method).toBe(`${batch}/7`);
    expect(current.broken).toEqual(run.broken);
    expect(current.failed).toEqual(run.failed);
    expect((await readFile(path)).length).toBeLessThan(1000);
  }
  expect(serializations).toBe(320);
  run.status = 'complete';
  await save(true);
  expect(serializations).toBe(640);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(await store.latestRun());
  expect((await store.latestRun()).visited).toHaveLength(320);
});

it('ignores an interrupted append beyond the published checkpoint', async () => {
  const { store, run } = await fixture();
  const save = await store.startRun(run);
  run.visited.push({ method: 'café', status: 'read' }); run.calls++;
  await save();
  await appendFile(join(store.runDir(run.id), 'progress.jsonl'), '{"visited":[');
  expect(await store.latestRun()).toEqual(run);
});

it('reports a missing journal instead of silently dropping saved answers', async () => {
  const { store, run } = await fixture();
  const save = await store.startRun(run);
  run.visited.push({ method: 'f' }); await save();
  await rm(join(store.runDir(run.id), 'progress.jsonl'));
  await expect(store.latestRun()).rejects.toThrow();
});

it('writes the full failure record including answers since the last checkpoint', async () => {
  const { store, run, path } = await fixture();
  const save = await store.startRun(run);
  run.visited.push({ method: 'f' }); await save();
  run.failed.push({ method: 'g', error: 'unavailable' });
  run.status = 'failed'; run.error = 'unavailable';
  await save(true);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(run);
  expect(await store.latestRun()).toEqual(run);
});
