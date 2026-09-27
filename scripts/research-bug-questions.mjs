/** Score candidate defect questions on saved public Perch method states. */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { createSystemOne } from '../src/systemone.js';

const [datasetArg, proposalsArg, outputArg, limitArg = '0', workersArg = '8', selectedArg] = process.argv.slice(2);
if (!datasetArg || !proposalsArg || !outputArg) throw new Error('Usage: node scripts/research-bug-questions.mjs <benchmark.jsonl> <proposals.json> <output.jsonl> [limit] [workers] [selected-ids.json]');
const key = process.env.TYPESAFE_API_KEY || process.env.PERCH_API_KEY;
if (!key) throw new Error('Set TYPESAFE_API_KEY or PERCH_API_KEY');
const dataset = resolve(datasetArg), output = resolve(outputArg);
const raw = readFileSync(dataset), pairs = raw.toString().trimEnd().split('\n').map(JSON.parse);
const rules = YAML.parse(readFileSync(new URL('../scan.yaml', import.meta.url), 'utf8'));
const proposals = JSON.parse(readFileSync(proposalsArg, 'utf8')).candidates;
const question = rule => ({ type: 'noul', instructions: rule.ask, criteria: { true: rule.true, false: rule.false } });
const candidates = Object.fromEntries(rules.filter(rule => rule.name === 'has_bug' || rule.name.startsWith('bug_'))
  .map(rule => [rule.name, question(rule)]));
for (const item of proposals) {
  const id = `proposed_${item.name}`;
  if (!/^[a-z][a-z0-9_]*$/.test(id) || candidates[id]) throw new Error(`Invalid candidate ${id}`);
  candidates[id] = question(item);
}
if (selectedArg) {
  const selected = JSON.parse(readFileSync(selectedArg, 'utf8'));
  if (!Array.isArray(selected) || !selected.length || selected.some(id => typeof id !== 'string' || !(id in candidates))) throw new Error('Invalid selected question IDs');
  for (const id of Object.keys(candidates)) if (!selected.includes(id)) delete candidates[id];
}
const fingerprint = value => createHash('sha256').update(value).digest('hex');
const manifest = { model: 'jev-1.13.0', dataset_sha256: fingerprint(raw),
  question_sha256: fingerprint(JSON.stringify(candidates)), candidate_ids: Object.keys(candidates) };
const manifestPath = `${output}.manifest.json`;
if (existsSync(manifestPath)) {
  if (JSON.stringify(JSON.parse(readFileSync(manifestPath))) !== JSON.stringify(manifest)) throw new Error('Candidate or dataset changed; choose a new output path');
} else writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const rows = pairs.flatMap(pair => ['before', 'after'].map(role => ({ pair_id: pair.pair_id, role, state: pair[role].state })));
const id = row => `${row.pair_id}\0${row.role}`;
const existing = new Set();
if (existsSync(output)) for (const line of readFileSync(output, 'utf8').trimEnd().split('\n')) {
  if (line) { const saved = JSON.parse(line); if (saved.status === 'ok') existing.add(id(saved)); }
}
const limit = Number(limitArg), workers = Number(workersArg);
if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(workers) || workers < 1 || workers > 24) throw new Error('Invalid limit/workers');
const pending = rows.filter(row => !existing.has(id(row))).slice(0, limit || undefined);
const client = createSystemOne({ apiKey: key, model: manifest.model });
let cursor = 0, done = 0, failed = 0, inputTokens = 0, nextStart = Date.now();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function worker() {
  while (cursor < pending.length) {
    const row = pending[cursor++];
    let result;
    try {
      const now = Date.now(), delay = Math.max(0, nextStart - now);
      nextStart = Math.max(now, nextStart) + 120;
      if (delay) await pause(delay);
      const response = await client.ask(row.state, candidates);
      if (response.model !== manifest.model) throw new Error(`Unexpected model ${response.model}`);
      const scores = Object.fromEntries(Object.keys(candidates).map(name => [name, response.answers[name]?.noul]));
      if (Object.values(scores).some(score => typeof score !== 'number' || score < 0 || score > 1)) throw new Error('Missing or invalid probability');
      inputTokens += response.usage?.input_tokens ?? 0;
      result = { pair_id: row.pair_id, role: row.role, status: 'ok', scores, usage: response.usage, requests: response.requests ?? 1 };
    } catch (error) { failed++; result = { pair_id: row.pair_id, role: row.role, status: 'error', error: String(error.message || error).slice(0, 300) }; }
    appendFileSync(output, JSON.stringify(result) + '\n');
    done++;
    if (done % 50 === 0 || done === pending.length) console.log(JSON.stringify({ done, total: pending.length, failed, inputTokens }));
  }
}
await Promise.all(Array.from({ length: Math.min(workers, pending.length) }, worker));
