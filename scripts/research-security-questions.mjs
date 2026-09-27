/** Score the shipped CWE questions and direct-wording candidates on saved Perch method states. */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { createSystemOne } from '../src/systemone.js';

const [datasetArg, candidatesArg, outputArg, workersArg = '8'] = process.argv.slice(2);
if (!datasetArg || !candidatesArg || !outputArg) throw new Error('Usage: node scripts/research-security-questions.mjs <pairs.jsonl> <candidates.json> <scores.jsonl> [workers]');
const key = process.env.TYPESAFE_API_KEY || process.env.PERCH_API_KEY;
if (!key) throw new Error('Set TYPESAFE_API_KEY or PERCH_API_KEY');
const dataset = readFileSync(resolve(datasetArg));
const pairs = dataset.toString().trimEnd().split('\n').map(JSON.parse);
const candidateRaw = readFileSync(resolve(candidatesArg));
const candidateRows = JSON.parse(candidateRaw);
const rules = YAML.parse(readFileSync(new URL('../scan.yaml', import.meta.url), 'utf8')).filter(rule => rule.name.startsWith('cwe_'));
const byName = new Map(rules.map(rule => [rule.name, rule]));
if (rules.length !== 30 || !Array.isArray(candidateRows)) throw new Error('Expected 30 CWE rules and a candidate array');
const format = rule => ({ type: 'noul', instructions: rule.ask, criteria: { true: rule.true, false: rule.false } });
const questions = Object.fromEntries(rules.map(rule => [rule.name, format(rule)]));
const languages = Object.fromEntries(rules.map(rule => [rule.name, rule.language ?? null]));
for (const candidate of candidateRows) {
  const base = byName.get(candidate.base);
  if (!base || !/^direct_cwe_[0-9]+$/.test(candidate.name) || candidate.name !== `direct_${base.name}` || questions[candidate.name]) throw new Error(`Invalid candidate ${candidate.name}`);
  if (['ask', 'true', 'false'].some(field => typeof candidate[field] !== 'string' || !candidate[field].trim())) throw new Error(`Incomplete candidate ${candidate.name}`);
  questions[candidate.name] = format(candidate);
  languages[candidate.name] = base.language ?? null;
}
const sha = raw => createHash('sha256').update(raw).digest('hex');
const manifest = { model: 'jev-1.13.0', dataset_sha256: sha(dataset), candidates_sha256: sha(candidateRaw),
  question_sha256: sha(JSON.stringify(questions)), language_filter: 'benchmark language; csharp normalized to Perch c_sharp', question_ids: Object.keys(questions) };
const output = resolve(outputArg), manifestPath = `${output}.manifest.json`;
if (existsSync(manifestPath)) {
  if (JSON.stringify(JSON.parse(readFileSync(manifestPath))) !== JSON.stringify(manifest)) throw new Error('Inputs changed; choose a new output path');
} else writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const rows = pairs.flatMap(pair => ['before', 'after'].map(role => ({ pair_id: pair.pair_id, role,
  language: pair.language === 'csharp' ? 'c_sharp' : pair.language, state: pair[role].state })));
const id = row => `${row.pair_id}\0${row.role}`;
const existing = new Set();
if (existsSync(output)) for (const line of readFileSync(output, 'utf8').trimEnd().split('\n')) {
  if (line) { const row = JSON.parse(line); if (row.status === 'ok') existing.add(id(row)); }
}
const pending = rows.filter(row => !existing.has(id(row)));
const workers = Number(workersArg);
if (!Number.isInteger(workers) || workers < 1 || workers > 24) throw new Error('Invalid worker count');
const client = createSystemOne({ apiKey: key, model: manifest.model });
let cursor = 0, done = 0, failed = 0, inputTokens = 0, nextStart = Date.now();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function worker() {
  while (cursor < pending.length) {
    const row = pending[cursor++];
    let result;
    try {
      const asked = Object.fromEntries(Object.entries(questions).filter(([name]) => !languages[name] || languages[name].includes(row.language)));
      const now = Date.now(), delay = Math.max(0, nextStart - now);
      nextStart = Math.max(now, nextStart) + 120;
      if (delay) await pause(delay);
      const response = await client.ask(row.state, asked);
      if (response.model !== manifest.model) throw new Error(`Unexpected model ${response.model}`);
      const scores = Object.fromEntries(Object.keys(asked).map(name => [name, response.answers[name]?.noul]));
      if (Object.values(scores).some(score => typeof score !== 'number' || score < 0 || score > 1)) throw new Error('Missing or invalid probability');
      inputTokens += response.usage?.input_tokens ?? 0;
      result = { pair_id: row.pair_id, role: row.role, status: 'ok', language: row.language, scores, usage: response.usage, requests: response.requests ?? 1 };
    } catch (error) { failed++; result = { pair_id: row.pair_id, role: row.role, status: 'error', error: String(error.message || error).slice(0, 300) }; }
    appendFileSync(output, JSON.stringify(result) + '\n');
    done++;
    if (done % 50 === 0 || done === pending.length) console.log(JSON.stringify({ done, total: pending.length, failed, inputTokens }));
  }
}
await Promise.all(Array.from({ length: Math.min(workers, pending.length) }, worker));
