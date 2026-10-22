import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIGS, CUTOFFS, jsonl, readLabels, score } from './core.mjs';

// Scores each configuration's saved runs against the golden labels in truth/, at each cutoff, prints a table and writes
// summary.json. With --results DIR it scores the <config>.jsonl files run.mjs wrote there instead, and writes DIR/summary.json.
const root = path.dirname(fileURLToPath(import.meta.url));
if (process.argv.length > 2 && (process.argv.length !== 4 || process.argv[2] !== '--results')) throw Error('Use score.mjs [--results DIR]');
const results = process.argv[3] ? path.resolve(process.argv[3]) : null;
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
const labels = await readLabels(root, manifest);
const files = results
  ? Object.fromEntries((await fs.readdir(results)).filter(file => file.endsWith('.jsonl')).map(file => [file.slice(0, -'.jsonl'.length), path.join(results, file)]))
  : Object.fromEntries(Object.keys(CONFIGS).map(config => [config, path.join(root, 'results', `${config}.jsonl.gz`)]));

const summary = [];
for (const [config, file] of Object.entries(files)) {
  const runs = new Map((await jsonl(file)).map(run => [run.pr, run]));
  for (const cutoff of CUTOFFS) summary.push({ config, label: CONFIGS[config] ?? config, ...score(manifest, labels, runs, cutoff) });
}
await fs.writeFile(path.join(results ?? root, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');

const inside = labels.filter(label => label.methods.length).length;
console.log(`${manifest.length} pull requests, ${labels.length} golden comments, ${inside} of them inside a function`);
console.log('\n| Configuration | Cutoff | PRs caught | Chance | Golden comments | Flags | Functions read | Median flags a PR | Cost |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const r of summary) {
  const incomplete = r.missing.length ? ` (${r.missing.length} pull requests missing or failed)` : '';
  console.log(`| ${r.label}${incomplete} | ${Math.round(r.cutoff * 100)}% | ${r.caught}/${r.of} | ${r.chance.toFixed(1)} | ${r.golden}/${r.golden_of} | ${r.flags} | ${r.read} | ${r.median_flags} | $${r.cost.toFixed(3)} |`);
}
