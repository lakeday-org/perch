import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonl, hash, decisionPayload, normalize, ARMS, verifyBundle } from './core.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
await verifyBundle(new URL('./', import.meta.url));
const option = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1]; };
for (let i = 2; i < process.argv.length; i += 2) if (!['--provider', '--out', '--limit', '--expected-model'].includes(process.argv[i]) || !process.argv[i + 1]) throw Error('Unknown or incomplete option');
const provider = option('provider');
if (!['jev', 'luna'].includes(provider)) throw Error('Use --provider jev|luna [--out DIR] [--limit N]');
const config = provider === 'jev'
  ? { key: process.env.TYPESAFE_API_KEY, url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-preview', expected: option('expected-model', 'jev-1.14.0'), price: .042 }
  : { key: process.env.OPENAI_API_KEY, url: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', expected: 'gpt-6-luna', price: .1 };
if (!config.key) throw Error(`Set ${provider === 'jev' ? 'TYPESAFE_API_KEY' : 'OPENAI_API_KEY'}`);
const packets = (await jsonl(path.join(root, 'requests.jsonl.gz'))).filter(p => ARMS.includes(p.arm)).slice(0, Number(option('limit', Infinity)));
const out = path.resolve(option('out', path.join(root, 'runs/live'))), cache = path.join(out, provider);
await fs.mkdir(cache, { recursive: true });
let next = 0, completed = 0, stop = false, nextSend = 0;
async function work(packet) {
  const input_hash = hash({ provider, expected: config.expected, packet }), file = path.join(cache, `${packet.id}-${packet.arm}.json`);
  try { const r = JSON.parse(await fs.readFile(file, 'utf8')); if (r.input_hash !== input_hash) throw Error('Cached request identity changed'); completed++; return; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const record = { id: packet.id, arm: packet.arm, provider, input_hash, answers: [], raw: [], usage: { input_tokens: 0, output_tokens: 0 }, seconds: 0, cost_usd: 0 };
  try {
    for (const step of packet.steps) {
      const questions = structuredClone(step.questions);
      const body = provider === 'luna' ? decisionPayload(step.state, questions) : { model: config.model, state: step.state, questions };
      const scheduled = Math.max(Date.now(), nextSend); nextSend = scheduled + 100;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, scheduled - Date.now())));
      if (stop) throw Error('Run stopped');
      const started = performance.now();
      const response = await fetch(config.url, { method: 'POST', headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      record.seconds += (performance.now() - started) / 1000;
      if (!response.ok) { await response.arrayBuffer(); if ([400, 401, 402, 403].includes(response.status)) stop = true; throw Error('HTTP ' + response.status); }
      const raw = await response.json(); record.raw.push(raw); record.model = raw.model;
      if (!Number.isSafeInteger(raw.usage?.input_tokens)) throw Error('Missing input usage');
      record.usage.input_tokens += raw.usage.input_tokens; record.usage.output_tokens += raw.usage.output_tokens ?? 0;
      record.cost_usd = record.usage.input_tokens * config.price / 1e6;
      if (raw.model !== config.expected) { stop = true; throw Error('Provider model changed; use a new output directory and --expected-model after reviewing its version'); }
      const answers = provider === 'luna' ? normalize(raw, questions) : raw.answers;
      if (provider === 'jev') for (const [name, q] of Object.entries(questions)) {
        const a = answers?.[name];
        if (q.type === 'noul' && (a?.type !== 'noul' || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1)) throw Error('Invalid probability');
      }
      record.answers.push(answers);
    }
  } catch (error) {
    record.failure = error.name === 'TimeoutError' ? 'Request timeout' : error.message;
    if (error.failure_counts) record.failure_counts = error.failure_counts;
  }
  await fs.writeFile(file, JSON.stringify(record) + '\n');
  completed++;
  if (completed % 100 === 0) console.log(JSON.stringify({ provider, completed, total: packets.length }));
}
await Promise.all(Array.from({ length: 8 }, async () => { while (!stop && next < packets.length) await work(packets[next++]); }));
const records = await Promise.all((await fs.readdir(cache)).filter(f => f.endsWith('.json')).sort().map(async f => JSON.parse(await fs.readFile(path.join(cache, f), 'utf8'))));
await fs.writeFile(path.join(out, provider + '.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(JSON.stringify({ provider, attempted: records.length, expected: packets.length, failed: records.filter(r => r.failure).length, cost_usd: records.reduce((n, r) => n + r.cost_usd, 0), stopped: stop }));
if (stop) process.exitCode = 1;
