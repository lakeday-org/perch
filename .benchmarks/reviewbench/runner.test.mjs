import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
const question = { bug: { type: 'noul', instructions: 'Does target contain a bug?', criteria: { true: 'A valid input fails.', false: 'Valid inputs work.' } } };
const step = source => ({ state: { source }, questions: question });

async function fixture(packets, mode) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perch-reviewbench-'));
  temporary.push(dir);
  for (const name of ['run.mjs', 'core.mjs']) await fs.copyFile(new URL(name, import.meta.url), path.join(dir, name));
  const data = gzipSync(packets.map(p => JSON.stringify(p)).join('\n'));
  await fs.writeFile(path.join(dir, 'requests.jsonl.gz'), data);
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ sha256: { 'requests.jsonl.gz': createHash('sha256').update(data).digest('hex') } }));
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
      return Response.json({ model: 'jev-1.14.0', usage: { input_tokens: 10, output_tokens: 0 },
        answers: { bug: { type: 'noul', noul: .8 } } });
    };
  `);
  const run = () => execFileSync(process.execPath, ['--import', path.join(dir, 'mock.mjs'), path.join(dir, 'run.mjs'), '--provider', 'jev', '--out', path.join(dir, 'out')], {
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
