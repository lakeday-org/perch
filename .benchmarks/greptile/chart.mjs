import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { barChart, THEMES } from '../bars.mjs';

// Draws the README's Greptile benchmark chart, light and dark, into .github/. Perch's rows are perch#418 on OpenAI's Decisions
// model at each cutoff, from summary.json; a pull request whose golden bugs sit in no function counts as a miss. The published
// rows are the catch rates greptile.com/benchmarks listed on the date below.
const root = path.dirname(fileURLToPath(import.meta.url));
const PUBLISHED_DATE = 'October 22, 2026';
const PUBLISHED = [
  { name: 'Greptile', value: 82 },
  { name: 'Cursor Bugbot', value: 58 },
  { name: 'GitHub Copilot', value: 54 },
  { name: 'CodeRabbit', value: 44 },
  { name: 'Graphite', value: 6 },
];

const summary = JSON.parse(await fs.readFile(path.join(root, 'summary.json'), 'utf8'));
const perch = summary.filter(r => r.config === 'oai2q').map(r => {
  const value = 100 * r.caught / (r.prs + r.missing.length);
  return { name: `OpenAI at ${Math.round(100 * r.cutoff)}%`, perch: true, value, text: `${Math.round(value)}%`, note: `${r.median_flags} flags a PR` };
});
const rows = [...PUBLISHED.map(r => ({ ...r, text: `${r.value}%` })), ...perch].sort((a, b) => b.value - a.value);

const chart = colors => barChart(colors, {
  title: 'Perch on the Greptile benchmark: pull requests caught',
  heading: 'Perch on the Greptile benchmark',
  subtitle: 'Pull requests caught, of 50. Perch rows add the median number of functions flagged in a pull request.',
  others: 'Published tools',
  desc: `Share of the benchmark's 50 pull requests caught, highest first. ${rows.map(r => r.perch
    ? `Perch with ${r.name}: ${r.text}, a median of ${r.note}.` : `${r.name}: ${r.text}.`).join(' ')}`,
  rows,
  footer: [
    `Published tools: greptile.com/benchmarks, read ${PUBLISHED_DATE}. Caught when a line comment identified the pull request's known bug.`,
    'Perch: caught when a function it flagged holds one of the golden bugs. .benchmarks/greptile in this repository.',
  ],
});

for (const [theme, colors] of Object.entries(THEMES)) {
  await fs.writeFile(path.join(root, '../../.github', `greptile-${theme}.svg`), chart(colors));
}
