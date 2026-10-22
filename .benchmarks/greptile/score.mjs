import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIGS, CUTOFFS, jsonl, readKnown, readLabels, score } from './core.mjs';
import { needData } from '../data.mjs';

// Scores each configuration's saved runs against each pull request's known bug in known.json, which is how Greptile graded the
// published tools, and against the golden labels in truth/, at each cutoff, prints a table and writes
// summary.json, all in the data folder. With --results DIR it scores the <config>.jsonl files run.mjs wrote there instead, and
// writes DIR/summary.json.
if (process.argv.length > 2 && (process.argv.length !== 4 || process.argv[2] !== '--results')) throw Error('Use score.mjs [--results DIR]');
const results = process.argv[3] ? path.resolve(process.argv[3]) : null;
const data = needData('greptile', ['manifest.json', 'known.json', 'truth', ...(results ? [] : Object.keys(CONFIGS).map(config => `results/${config}.jsonl.gz`))]);
const manifest = JSON.parse(await fs.readFile(path.join(data, 'manifest.json'), 'utf8'));
const labels = await readLabels(data, manifest), known = await readKnown(data);
const files = results
  ? Object.fromEntries((await fs.readdir(results)).filter(file => file.endsWith('.jsonl')).map(file => [file.slice(0, -'.jsonl'.length), path.join(results, file)]))
  : Object.fromEntries(Object.keys(CONFIGS).map(config => [config, path.join(data, 'results', `${config}.jsonl.gz`)]));

const summary = [];
for (const [config, file] of Object.entries(files)) {
  const runs = new Map((await jsonl(file)).map(run => [run.pr, run]));
  for (const cutoff of CUTOFFS) summary.push({ config, label: CONFIGS[config] ?? config, ...score(manifest, labels, runs, cutoff, known) });
}
await fs.writeFile(path.join(results ?? data, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');

const inside = labels.filter(label => label.methods.length).length;
console.log(`${manifest.length} pull requests, ${known.filter(bug => bug.methods.length).length} known bugs inside a function, ${labels.length} golden comments, ${inside} of them inside a function`);
console.log('\n| Configuration | Cutoff | Known bugs caught | Chance | PRs with a golden bug caught | Golden comments | Flags | Functions read | Median flags a PR | Cost |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const r of summary) {
  const incomplete = r.missing.length ? ` (${r.missing.length} pull requests missing or failed)` : '';
  console.log(`| ${r.label}${incomplete} | ${Math.round(r.cutoff * 100)}% | ${r.known}/${r.known_of} (${Math.round(100 * r.known / r.known_of)}%) | ${r.known_chance.toFixed(1)} | ${r.caught}/${r.of} | ${r.golden}/${r.golden_of} | ${r.flags} | ${r.read} | ${r.median_flags} | $${r.cost.toFixed(3)} |`);
}
