import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { barChart, THEMES } from '../bars.mjs';

// Draws the README's ReviewBench recall chart, light and dark, into .github/. Perch's rows are the rerun on OpenAI's Decisions
// model at each cutoff, from rerun-summary.json, each with its precision; the leaderboard's are the grounded recall
// review-bench.ai listed on the date below, so a new leaderboard means new rows and a new date here.
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

const summary = JSON.parse(await fs.readFile(path.join(root, 'rerun-summary.json'), 'utf8'));
const pct = x => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
const rows = [
  ...LEADERBOARD.map(r => ({ name: r.name, value: r.recall, text: `${r.recall.toFixed(1)}%` })),
  ...summary.cutoffs.map(c => ({ name: `OpenAI at ${Math.round(100 * c.cutoff)}%`, perch: true, value: Math.round(c.total.recall * 1000) / 10,
    text: pct(c.total.recall), note: `${pct(c.total.precision)} precision` })),
].sort((a, b) => b.value - a.value);

const chart = colors => barChart(colors, {
  title: 'Perch on ReviewBench: recall',
  heading: 'Perch on ReviewBench',
  subtitle: 'Recall',
  others: 'Leaderboard reviewers',
  desc: `Recall on ReviewBench for perch beside the reviewers on its leaderboard, highest first. ${rows.map(r => r.perch
    ? `Perch with ${r.name}: ${r.text}, ${r.note}.` : `${r.name}: ${r.text}.`).join(' ')}`,
  rows,
  footer: [`Leaderboard: review-bench.ai, grounded recall, ${LEADERBOARD_DATE}. Perch: share of buggy methods it flagged, .benchmarks/reviewbench in this repository.`],
});

for (const [theme, colors] of Object.entries(THEMES)) {
  await fs.writeFile(path.join(root, '../../.github', `reviewbench-${theme}.svg`), chart(colors));
}
