import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonl, flagsOf, metric, ARMS, verifyBundle } from './core.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
await verifyBundle(new URL('./', import.meta.url));
const option = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1]; };
if (process.argv.length > 2 && (process.argv.length !== 4 || process.argv[2] !== '--results')) throw Error('Use score.mjs [--results DIR]');
const results = option('results');
const targets = await jsonl(path.join(root, 'targets.jsonl'));
const packets = new Map((await jsonl(path.join(root, 'requests.jsonl.gz'))).map(p => [`${p.id}:${p.arm}`, p]));
const result = [];
for (const provider of ['jev', 'luna']) {
  const records = await jsonl(results ? path.resolve(results, provider + '.jsonl') : path.join(root, 'results', provider + '.jsonl.gz'));
  const seen = new Set();
  for (const r of records) {
    const key = `${r.id}:${r.arm}`;
    if (seen.has(key) || !packets.has(key)) throw Error('Duplicate or unknown result ' + key);
    if (r.interrupted) throw Error('Incomplete interrupted request ' + key);
    seen.add(key);
  }
    const selected = records.filter(r => ARMS.includes(r.arm));
    const expected = [...packets.values()];
    if (selected.length !== expected.length) throw Error(`${provider}: incomplete coverage (${selected.length}/${expected.length})`);
    const predicted = new Set(), failed = new Set();
    for (const r of selected) {
      if (r.failure) failed.add(r.id);
      for (const id of flagsOf(r)) predicted.add(id);
    }
    result.push({ provider, ...metric(targets, predicted, failed), cost_usd: selected.reduce((n, r) => n + (r.cost_usd ?? 0), 0) });
}
await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log('| Model | TP | FP | FN | Precision | Recall | F1 | Cost |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const r of result) console.log(`| ${r.provider} | ${r.tp} | ${r.fp} | ${r.fn} | ${(100 * r.precision).toFixed(1)}% | ${(100 * r.recall).toFixed(1)}% | ${(100 * r.f1).toFixed(1)}% | $${r.cost_usd.toFixed(4)} |`);
