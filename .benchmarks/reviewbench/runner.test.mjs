import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
const question = { bug: { type: 'noul', instructions: 'Does target contain a bug?', criteria: { true: 'A valid input fails.', false: 'Valid inputs work.' } } };
const step = source => ({ state: { source }, questions: question });

/** A copy of .benchmarks in a temporary directory: the scripts, and the data in hf/reviewbench/ unless `packets` is null. */
async function scripts(names, packets, mode) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perch-reviewbench-'));
  temporary.push(dir);
  await fs.mkdir(path.join(dir, 'reviewbench'));
  for (const name of names) await fs.copyFile(new URL(name, import.meta.url), path.join(dir, 'reviewbench', name));
  await fs.copyFile(new URL('../data.mjs', import.meta.url), path.join(dir, 'data.mjs'));
  if (!packets) return dir;
  const hf = path.join(dir, 'hf', 'reviewbench');
  await fs.mkdir(hf, { recursive: true });
  const data = gzipSync(packets.map(p => JSON.stringify(p)).join('\n'));
  await fs.writeFile(path.join(hf, 'requests.jsonl.gz'), data);
  const targets = Buffer.from([...new Set(packets.map(p => p.id))].map(id => JSON.stringify({ id, name: mode === 'file' ? '<file>' : 'testMethod' })).join('\n') + '\n');
  await fs.writeFile(path.join(hf, 'targets.jsonl'), targets);
  await fs.writeFile(path.join(hf, 'manifest.json'), JSON.stringify({ target_scope: 'method', sha256: Object.fromEntries([['requests.jsonl.gz', data], ['targets.jsonl', targets]].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])) }));
  return dir;
}

async function fixture(packets, mode) {
  const dir = await scripts(['run.mjs', 'core.mjs'], packets, mode);
  await fs.writeFile(path.join(dir, 'mock.mjs'), `
    import fs from 'node:fs';
    const countFile = new URL('./calls.json', import.meta.url);
    globalThis.fetch = async (_url, init) => {
      const calls = fs.existsSync(countFile) ? JSON.parse(fs.readFileSync(countFile, 'utf8')) : [];
      const body = JSON.parse(init.body); calls.push(body.state.source);
      fs.writeFileSync(countFile, JSON.stringify(calls));
      if (${JSON.stringify(mode)} === 'interrupt' && calls.length === 1) {
        process.kill(process.pid, 'SIGTERM'); await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (${JSON.stringify(mode)} === 'reject' && calls.length === 1) return new Response('', { status: 400 });
      if (${JSON.stringify(mode)} === 'unauthorized' && calls.length === 1) return new Response('', { status: 401 });
      return Response.json({ model: 'jev-1.14.0', usage: { input_tokens: 10, output_tokens: 0 },
        answers: { bug: { type: 'noul', noul: .8 } } });
    };
  `);
  const run = () => execFileSync(process.execPath, ['--import', path.join(dir, 'mock.mjs'), path.join(dir, 'reviewbench', 'run.mjs'), '--provider', 'jev', '--out', path.join(dir, 'out')], {
    env: { ...process.env, TYPESAFE_API_KEY: 'test-only' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
  });
  return { dir, run, read: file => fs.readFile(path.join(dir, file), 'utf8').then(JSON.parse) };
}

it('resumes an interrupted reading without repeating its completed step or losing usage', async () => {
  const { run, read } = await fixture([{ id: 'target', arm: 'change_current', steps: [step('first'), step('second')] }], 'interrupt');
  expect(run).toThrow();
  const partial = await read('out/jev/target-change_current.json');
  expect(partial.interrupted).toBe(true);
  expect(partial.answers).toHaveLength(1);
  expect(partial.failure).toBeUndefined();
  run();
  const complete = await read('out/jev/target-change_current.json');
  expect(complete.interrupted).toBeUndefined();
  expect(complete.answers).toHaveLength(2);
  expect(complete.usage.input_tokens).toBe(20);
  expect(await read('calls.json')).toEqual(['first', 'second']);
  run();
  expect(await read('calls.json')).toEqual(['first', 'second']);
});

it('records a rejected input as failed and continues the remaining targets', async () => {
  const { run, read } = await fixture([
    { id: 'a', arm: 'change_current', steps: [step('rejected')] },
    { id: 'b', arm: 'change_current', steps: [step('accepted')] },
  ], 'reject');
  run();
  expect((await read('out/jev/a-change_current.json')).failure).toBe('HTTP 400');
  expect((await read('out/jev/b-change_current.json')).failure).toBeUndefined();
  expect(await read('calls.json')).toEqual(['rejected', 'accepted']);
});

it('stops on a refused key and leaves that reading for the resumed run', async () => {
  const { run, read } = await fixture([{ id: 'target', arm: 'change_current', steps: [step('first')] }], 'unauthorized');
  expect(run).toThrow();
  const partial = await read('out/jev/target-change_current.json');
  expect(partial.failure).toBeUndefined();
  expect(partial.interrupted).toBe(true);
  run();
  expect((await read('out/jev/target-change_current.json')).answers).toHaveLength(1);
  expect(await read('calls.json')).toEqual(['first', 'first']);
});

it('rejects whole-file targets before making a model request', async () => {
  const { run, read } = await fixture([{ id: 'file', arm: 'change_current', steps: [step('whole file')] }], 'file');
  expect(run).toThrow(/method-only/);
  await expect(read('calls.json')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('says how to download the data and exits 2 when it is not there, before asking for a key', async () => {
  const dir = await scripts(['run.mjs', 'score.mjs', 'core.mjs'], null);
  for (const script of ['score.mjs', 'run.mjs']) {
    const result = spawnSync(process.execPath, [path.join(dir, 'reviewbench', script), ...(script === 'run.mjs' ? ['--provider', 'jev'] : [])], {
      cwd: dir, env: { ...process.env, TYPESAFE_API_KEY: '' }, encoding: 'utf8', timeout: 10000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("hf download perchscan/benchmark-results --repo-type dataset --include 'reviewbench/*' --local-dir hf");
  }
});
