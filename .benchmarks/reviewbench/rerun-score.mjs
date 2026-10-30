import fs from 'node:fs/promises';
import path from 'node:path';
import { flagsOf, jsonl } from './core.mjs';
import { needData } from '../data.mjs';

// Scores the rerun (results/rerun-luna.jsonl.gz, or another run's lines with --results FILE) against targets.jsonl, the
// methods the frozen run scored, at each cutoff. A target is matched to the method perch read in the same pull request and file
// whose lines overlap it most, by intersection over union, a matching name breaking ties; <top-level> and <file> readings are
// left out, as they are from the targets. A target perch did not read counts as not flagged. Prints a table and writes
// rerun-summary.json, or the file named by --summary.
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1]; };
if (args.length % 2 || args.some((arg, i) => i % 2 === 0 && !['--results', '--summary'].includes(arg))) throw Error('Use rerun-score.mjs [--results FILE] [--summary FILE]');
const data = needData('reviewbench', ['targets.jsonl', 'results/jev.jsonl.gz', 'results/luna.jsonl.gz', ...(option('results') ? [] : ['results/rerun-luna.jsonl.gz'])]);
const CUTOFFS = [0.6, 0.7, 0.8], SPLITS = ['total', 'development', 'validation'];
const reference = t => t.labels.some(label => label.source.startsWith('reference'));
const buggy = t => t.labels.length > 0;

const targets = await jsonl(path.join(data, 'targets.jsonl'));
const lines = await jsonl(option('results') ? path.resolve(option('results')) : path.join(data, 'results', 'rerun-luna.jsonl.gz'));
const byPr = new Map();
for (const t of targets) byPr.set(t.pr, [...(byPr.get(t.pr) ?? []), t]);
const lastSegment = name => String(name).split(/::|\.| > /).at(-1).trim();

/** The reading a target is matched to, or null when perch read nothing that overlaps it. */
function match(target, readings) {
  let best = null, bestKey = null;
  for (const r of readings) {
    if (r.path !== target.path || r.name === '<top-level>' || r.name === '<file>') continue;
    const overlap = Math.min(r.end_line, target.end_line) - Math.max(r.line, target.start_line) + 1;
    if (overlap <= 0) continue;
    const key = [overlap / (Math.max(r.end_line, target.end_line) - Math.min(r.line, target.start_line) + 1), r.name === target.name ? 1 : 0, lastSegment(r.name) === lastSegment(target.name) ? 1 : 0];
    if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && (key[1] > bestKey[1] || (key[1] === bestKey[1] && key[2] > bestKey[2])))) { best = r; bestKey = key; }
  }
  return best;
}

function metric(rows, flagged, isBuggy = buggy) {
  let tp = 0, fp = 0, fn = 0;
  for (const t of rows) { const yes = flagged(t); if (isBuggy(t)) { if (yes) tp++; else fn++; } else if (yes) fp++; }
  const precision = tp / (tp + fp) || 0, recall = tp / (tp + fn) || 0;
  return { targets: rows.length, buggy: tp + fn, flagged: tp + fp, flag_rate: (tp + fp) / rows.length, precision, recall, f1: 2 * tp / (2 * tp + fp + fn) || 0, correct: tp, false: fp, missed: fn };
}
const bySplit = fn => Object.fromEntries(SPLITS.map(split => [split, fn(split === 'total' ? targets : targets.filter(t => t.split === split))]));

const matched = new Map(), parsed = new Set(), failed = [], usage = {};
let readings = 0;
for (const line of lines) {
  for (const [model, u] of Object.entries(line.usage)) {
    usage[model] ??= { requests: 0, input: 0, output: 0, cost: 0 };
    for (const key of Object.keys(usage[model])) usage[model][key] += u[key] ?? 0;
  }
  if (![0, 3].includes(line.code)) { failed.push({ pr: line.pr, code: line.code, error: line.error }); continue; }
  for (const file of Object.keys(line.files)) parsed.add(`${line.pr}\0${file}`);
  // A method read twice keeps its higher answers, as perch's own merge does.
  const merged = new Map();
  for (const r of line.readings) {
    const seen = merged.get(r.method);
    merged.set(r.method, { ...r, has_bug: Math.max(r.has_bug ?? 0, seen?.has_bug ?? 0), bug_edge_case: Math.max(r.bug_edge_case ?? 0, seen?.bug_edge_case ?? 0) });
  }
  readings += merged.size;
  for (const t of byPr.get(line.pr) ?? []) { const r = match(t, [...merged.values()]); if (r) matched.set(t.id, r); }
}
const scanned = new Set(lines.filter(line => [0, 3].includes(line.code)).map(line => line.pr));
if (byPr.size !== lines.length || [...byPr.keys()].some(pr => !lines.some(line => line.pr === pr))) throw Error(`The run has ${lines.length} of ${byPr.size} pull requests`);

const above = cutoff => t => { const r = matched.get(t.id); return !!r && (r.has_bug > cutoff || r.bug_edge_case > cutoff); };
const frozen = {};
for (const provider of ['jev', 'luna']) {
  const predicted = new Set(), failures = new Set();
  for (const r of await jsonl(path.join(data, 'results', `${provider}.jsonl.gz`))) { if (r.failure) failures.add(r.id); for (const id of flagsOf(r)) predicted.add(id); }
  // A failed reading is a miss if buggy and a false alert if clean, as score.mjs counts it.
  frozen[provider] = metric(targets, t => (failures.has(t.id) ? !reference(t) : predicted.has(t.id)), reference);
}
const summary = {
  targets: targets.length, buggy: targets.filter(buggy).length, buggy_reference: targets.filter(reference).length, prs: byPr.size,
  scanned_prs: scanned.size, failed, readings, targets_read: matched.size,
  // Buggy targets the rerun read no method of: in a pull request it could not check out, in a file it did not parse, or in a
  // function of a parsed file that it did not read, which on --since is one the diff did not change.
  unread_buggy: {
    in_failed_prs: targets.filter(t => buggy(t) && !scanned.has(t.pr)).length,
    in_unparsed_files: targets.filter(t => buggy(t) && scanned.has(t.pr) && !parsed.has(`${t.pr}\0${t.path}`)).length,
    in_unread_functions: targets.filter(t => buggy(t) && parsed.has(`${t.pr}\0${t.path}`) && !matched.has(t.id)).length,
  },
  usage, cost_usd: Object.values(usage).reduce((n, u) => n + u.cost, 0),
  cutoffs: CUTOFFS.map(cutoff => ({ cutoff, ...bySplit(rows => metric(rows, above(cutoff))), reference_only: metric(targets, above(cutoff), reference) })),
  frozen_reference_only: frozen,
};
await fs.writeFile(option('summary') ? path.resolve(option('summary')) : path.join(data, 'rerun-summary.json'), JSON.stringify(summary, null, 1) + '\n');

const pct = x => `${(100 * x).toFixed(1)}%`;
const row = (name, m) => `| ${name} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} | ${pct(m.flag_rate)} | ${m.correct} | ${m.false} | ${m.missed} |`;
console.log(`${summary.targets} targets in ${summary.prs} pull requests, ${summary.buggy} buggy (${summary.buggy_reference} from reference findings); ${summary.scanned_prs} scanned, ${summary.targets_read} targets read, $${summary.cost_usd.toFixed(4)}`);
for (const split of [...SPLITS, 'reference_only']) {
  console.log(`\n### ${split.replace('_', ' ')}\n\n| Cutoff | Precision | Recall | F1 | Flag rate | Correct alerts | False alerts | Missed bugs |\n|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const c of summary.cutoffs) console.log(row(`${Math.round(100 * c.cutoff)}%`, c[split]));
  if (split === 'reference_only') for (const [provider, m] of Object.entries(frozen)) console.log(row(`frozen run, ${provider}`, m));
}
