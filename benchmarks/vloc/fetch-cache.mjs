/** Benchmark-only transport cache. The CLI still builds and scores its ordinary requests. */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.env.VLOC_TRANSPORT_CACHE;
if (!directory) throw new Error('VLOC_TRANSPORT_CACHE is required');
mkdirSync(directory, { recursive: true });
const stop = join(directory, 'STOP.json');
const endpoint = process.env.PERCH_BASE_URL || 'https://api.typesafe.ai/v1/systemone';
const original = globalThis.fetch;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const write = (path, value) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value)); renameSync(temporary, path);
};
const check = () => { if (existsSync(stop)) throw new Error(`Benchmark transport stopped: ${readFileSync(stop, 'utf8')}`); };

async function lock(path, honorStop = true) {
  for (;;) {
    if (honorStop) check();
    try { writeFileSync(path, String(process.pid), { flag: 'wx' }); return () => unlinkSync(path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // A crash can leave a lock file. Only its dead owner permits recovery; elapsed time alone never does.
    try {
      const owner = Number(readFileSync(path, 'utf8'));
      if (owner > 0) {
        try { process.kill(owner, 0); }
        catch (error) { if (error.code === 'ESRCH') unlinkSync(path); else throw error; }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await pause(20);
  }
}

globalThis.fetch = async (url, options) => {
  if (String(url) !== endpoint) return original(url, options);
  check();
  if (typeof options?.body !== 'string') throw new Error('Expected a serialized benchmark request');
  // Authentication never enters a filename, cached response, or ledger.
  const key = createHash('sha256').update(JSON.stringify([String(url), options.body])).digest('hex');
  const path = join(directory, `${key}.json`);
  const release = await lock(`${path}.lock`);
  try {
    check();
    if (existsSync(path)) {
      const body = JSON.parse(readFileSync(path, 'utf8'));
      appendFileSync(join(directory, 'cache-hits.jsonl'), JSON.stringify({ key, at: new Date().toISOString() }) + '\n');
      // Cached answers incur no provider token usage on this attempt.
      return new Response(JSON.stringify({ ...body, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200 });
    }
    const budget = JSON.parse(readFileSync(join(directory, 'budget.json'), 'utf8'));
    if (budget.spent_usd >= budget.limit_usd) {
      write(stop, { reason: 'budget', spent_usd: budget.spent_usd }); check();
    }
    // Persist the attempt before sending. An unknown outcome must be reviewed, never automatically sent a second time.
    const pending = `${path}.pending`;
    if (existsSync(pending)) {
      write(stop, { reason: 'uncertain_request', key }); check();
    }
    write(pending, { pid: process.pid, at: new Date().toISOString() });
    const response = await original(url, options);
    const body = await response.clone().json();
    const input = body.usage?.input_tokens || 0, output = body.usage?.output_tokens || 0;
    const cost = input * 0.042 / 1e6;
    const budgetRelease = await lock(join(directory, 'budget.lock'), false);
    try {
      const current = JSON.parse(readFileSync(join(directory, 'budget.json'), 'utf8'));
      write(join(directory, 'budget.json'), { ...current, spent_usd: current.spent_usd + cost });
      appendFileSync(join(directory, 'network.jsonl'), JSON.stringify({ key, status: response.status, model: body.model, input, output, estimated_usd: cost, at: new Date().toISOString() }) + '\n');
    } finally { budgetRelease(); }
    if (response.ok) write(path, body);
    if ([401, 402, 403].includes(response.status)) write(stop, { reason: 'access', status: response.status });
    // Successful responses are safely cached, and HTTP failures have a known outcome.
    unlinkSync(pending);
    return response;
  } finally { release(); }
};
