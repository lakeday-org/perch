import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { barChart, THEMES } from '../bars.mjs';
import { needData } from '../data.mjs';

// Draws the README's ReviewBench recall chart, light and dark, into .github/. Perch's row is the rerun on OpenAI's Decisions
// model at its default 60% floor, from rerun-summary.json, with the model's measured cost of a pull request; the leaderboard's are
// the grounded recall review-bench.ai listed on the date below, so a new leaderboard means new rows and a new date here.
const root = path.dirname(fileURLToPath(import.meta.url));
const LEADERBOARD_DATE = 'October 17, 2026';
const LEADERBOARD = [
  { name: 'Laude RevEngine Prime', recall: 46.3 },
  { name: 'block/review', recall: 32.6 },
  { name: 'Klaussy', recall: 29.8 },
  { name: 'Copilot code review', recall: 26.0 },
  { name: 'DeepSeek Harness Reviewer', recall: 25.6 },
  { name: 'Devin AI', recall: 23.8 },
  { name: 'Qodo', recall: 22.1 },
  { name: 'Codex', recall: 18.5 },
  { name: 'Cubic', recall: 16.3 },
  { name: 'Greptile', recall: 16.2 },
  { name: 'Cursor', recall: 9.6 },
];

const data = needData('reviewbench', ['rerun-summary.json', 'manifest.json']);
const summary = JSON.parse(await fs.readFile(path.join(data, 'rerun-summary.json'), 'utf8'));
const { selected_prs: selected } = JSON.parse(await fs.readFile(path.join(data, 'manifest.json'), 'utf8'));
const pct = x => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
const run = summary.cutoffs.find(c => c.cutoff === 0.6), perPr = `${(Math.round(summary.cost_usd / summary.scanned_prs * 1000) / 10).toFixed(1)}¢`;
const rows = [
  ...LEADERBOARD.map(r => ({ name: r.name, value: r.recall, text: `${r.recall.toFixed(1)}%` })),
  { name: 'Perch', perch: true, value: Math.round(run.total.recall * 1000) / 10, text: pct(run.total.recall) },
].sort((a, b) => b.value - a.value);
const place = rows.findIndex(r => r.perch) + 1, ordinal = ['first', 'second', 'third', 'fourth', 'fifth'][place - 1] ?? `number ${place}`;

const chart = colors => barChart(colors, {
  title: 'Perch on ReviewBench',
  kicker: 'ReviewBench',
  headline: `Perch places ${ordinal} on GitHub's ReviewBench, for ${perPr} a pull request`,
  subtitle: `Recall: the share of a human review's findings each reviewer found, across ReviewBench's ${selected} pull requests.`,
  columns: { value: 'Recall' },
  desc: `Recall on ReviewBench for perch beside the reviewers on its leaderboard, highest first. ${rows.map(r => `${r.name}: ${r.text}.`).join(' ')}`,
  rows,
  footer: [
    `Perch: OpenAI's Decisions model at its default 60% floor, ${pct(run.total.precision)} precision, scored per function. Model cost measured over ${summary.scanned_prs} pull requests.`,
    `Leaderboard: review-bench.ai, grounded recall, ${LEADERBOARD_DATE}, where a judge model matches each reviewer's comments to the findings.`,
  ],
});

for (const [theme, colors] of Object.entries(THEMES)) {
  await fs.writeFile(path.join(root, '../../.github', `reviewbench-${theme}.svg`), chart(colors));
}
