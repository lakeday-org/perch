import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export async function jsonl(file) {
  const data = await fs.readFile(file);
  return (file.endsWith('.gz') ? gunzipSync(data) : data).toString().trim().split('\n').filter(Boolean).map(JSON.parse);
}
export async function verifyBundle(root) {
  const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', root), 'utf8'));
  for (const [file, expected] of Object.entries(manifest.sha256)) {
    const actual = createHash('sha256').update(await fs.readFile(new URL(file, root))).digest('hex');
    if (actual !== expected) throw Error('Snapshot hash mismatch: ' + file);
  }
  const targets = await jsonl(fileURLToPath(new URL('targets.jsonl', root)));
  if (manifest.target_scope !== 'method' || targets.some(t => !t.name || ['<file>', '<top-level>'].includes(t.name))) throw Error('ReviewBench inputs must be method-only');
  return manifest;
}
export const SECURITY = new Set(['change_security', 'access_scope', 'security', 'file_security', 'access_boundary', 'execution_boundary']);
export const ARMS = ['change_current', 'relation'];

/** Preserve criteria as two choices, including when their descriptions are long. A question without both is not sent. */
export function decisionPayload(state, questions) {
  return { model: 'gpt-6-luna', input: JSON.stringify(state), questions: Object.entries(questions).map(([name, q]) => {
    if (q.type !== 'noul' || q.criteria?.true === undefined || q.criteria?.false === undefined) throw Error('Unsupported question shape');
    const instructions = typeof q.instructions === 'string' ? q.instructions : JSON.stringify(q.instructions);
    return { type: 'choice', name, instructions, choices: ['true', 'false'].map(value => ({ value, description: q.criteria[value] })) };
  }) };
}
export function normalize(reply, questions) {
  const expected = Object.keys(questions), entries = reply.answers ?? [];
  if (entries.length !== expected.length || new Set(entries.map(a => a.name)).size !== entries.length) throw Error('Missing or duplicate answers');
  const out = {};
  for (const a of entries) {
    const q = questions[a.name];
    if (!q) throw Error('Unexpected answer name');
    if (a.type === 'refusal') { const e = Error('Refusal'); e.failure_counts = Object.fromEntries(entries.filter(x => x.type === 'refusal').map(x => [x.name, 1])); throw e; }
    const probability = p => { if (!Number.isFinite(p) || p < 0 || p > 1) throw Error('Invalid probability'); return p; };
    if (a.type !== 'choice') throw Error('Wrong answer type');
    const values = ['true', 'false'];
    const ps = Object.fromEntries((a.probabilities ?? []).map(p => [String(p.value), probability(p.probability)]));
    if (Object.keys(ps).length !== values.length || a.probabilities.length !== values.length || values.some(v => !(v in ps)) || Math.abs(Object.values(ps).reduce((a, b) => a + b, 0) - 1) > .001) throw Error('Invalid distribution');
    out[a.name] = { type: 'noul', noul: ps.true };
  }
  return out;
}

/** Each reading answers about the target that supplied its code. */
export function flagsOf(record) {
  if (record.failure) return [];
  const flags = new Set();
  for (const answers of (Array.isArray(record.answers) ? record.answers : [record.answers])) {
    for (const [question, a] of Object.entries(answers)) if (a.type === 'noul' && a.noul > (SECURITY.has(question) ? .7 : .6)) flags.add(record.id);
  }
  return [...flags];
}

export function metric(targets, predicted, failed = new Set()) {
  const truth = new Set(targets.filter(t => t.labels.length).map(t => t.id));
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const t of targets) {
    const yes = failed.has(t.id) ? !truth.has(t.id) : predicted.has(t.id);
    if (truth.has(t.id)) { if (yes) tp++; else fn++; } else if (yes) fp++; else tn++;
  }
  const precision = tp / (tp + fp) || 0, recall = tp / (tp + fn) || 0;
  return { targets: targets.length, tp, fp, fn, tn, precision, recall, f1: 2 * tp / (2 * tp + fp + fn) || 0, failed_targets: failed.size };
}
