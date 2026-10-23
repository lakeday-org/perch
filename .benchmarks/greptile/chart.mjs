import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { barChart, THEMES } from '../bars.mjs';
import { needData } from '../data.mjs';

// Draws the README's Greptile benchmark chart, light and dark, into .github/. Perch's rows are perch#418 on OpenAI's Decisions
// model at each cutoff, from summary.json, graded as Greptile graded the published tools: on each pull request's one known bug,
// out of all 50, so one whose known bug sits in no function counts as a miss. The published rows are the catch rates
// greptile.com/benchmarks listed on the date below.
const root = path.dirname(fileURLToPath(import.meta.url));
const PUBLISHED_DATE = 'October 22, 2026';
const PUBLISHED = [
  { name: 'Greptile', value: 82 },
  { name: 'Cursor Bugbot', value: 58 },
  { name: 'GitHub Copilot', value: 54 },
  { name: 'CodeRabbit', value: 44 },
  { name: 'Graphite', value: 6 },
];

const data = needData('greptile', ['summary.json']);
const summary = JSON.parse(await fs.readFile(path.join(data, 'summary.json'), 'utf8'));
// 60% and 80%, the two cutoffs worth choosing between, as on the ReviewBench chart.
const perch = summary.filter(r => r.config === 'oai2q' && [0.6, 0.8].includes(r.cutoff)).map(r => {
  const value = 100 * r.known / r.known_of;
  return { name: `OpenAI at ${Math.round(100 * r.cutoff)}%`, perch: true, value, text: `${Math.round(value)}%`, note: `${r.median_flags} flags a PR` };
});
const rows = [...PUBLISHED.map(r => ({ ...r, text: `${r.value}%` })), ...perch].sort((a, b) => b.value - a.value);

const chart = colors => barChart(colors, {
  title: 'Perch on the Greptile benchmark: known bugs caught',
  heading: 'Perch on the Greptile benchmark',
  subtitle: 'Known bugs caught, of 50. Perch rows add the median number of functions flagged in a pull request.',
  others: 'Published tools',
  desc: `Share of the benchmark's 50 known bugs caught, highest first. ${rows.map(r => r.perch
    ? `Perch with ${r.name}: ${r.text}, a median of ${r.note}.` : `${r.name}: ${r.text}.`).join(' ')}`,
  rows,
  footer: [
    `Published tools: greptile.com/benchmarks, read ${PUBLISHED_DATE}. Caught when a line comment identified the pull request's known bug.`,
    'Perch: caught when a function it flagged holds the known bug. .benchmarks/greptile in this repository.',
  ],
});

for (const [theme, colors] of Object.entries(THEMES)) {
  await fs.writeFile(path.join(root, '../../.github', `greptile-${theme}.svg`), chart(colors));
}
