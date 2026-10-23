import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { barChart, THEMES } from '../bars.mjs';
import { needData } from '../data.mjs';

// Draws the README's Greptile benchmark chart, light and dark, into .github/: known bugs caught out of 50, graded as Greptile
// graded the published tools, beside what a pull request costs with each. Perch's row is perch#418 on OpenAI's Decisions model at
// its default 60% floor, from summary.json, and its cost is the model's, measured on that run. The published rows are the catch
// rates greptile.com/benchmarks listed on the date below, and their costs are list prices: a seat plan is divided over 20 pull
// requests a developer a month, as on perchscan.com's pricing.
const root = path.dirname(fileURLToPath(import.meta.url));
const PUBLISHED_DATE = 'October 22, 2026';
const PUBLISHED = [
  // $30 a seat with 50 reviews (greptile.com/pricing, October 3, 2026).
  { name: 'Greptile', value: 82, extra: '~$1' },
  // Bugbot comes with Cursor's Teams plan, $30 a seat (cursor.com/pricing, October 23, 2026).
  { name: 'Cursor Bugbot', value: 58, extra: '~$1.50' },
  // Code review draws on a plan's usage credits, and GitHub gives no cost for one (github.com/features/copilot/plans).
  { name: 'GitHub Copilot', value: 54, extra: 'usage credits' },
  // $24 to $60 a developer a month (coderabbit.ai/pricing, October 3, 2026).
  { name: 'CodeRabbit', value: 44, extra: '$1–3' },
  // Team, $40 a seat with unlimited reviews (graphite.com/pricing, October 23, 2026).
  { name: 'Graphite', value: 6, extra: '~$2' },
];
// In dollars, as every other tool's cost is, to a tenth of a cent below a cent: $0.007.
const usd = dollars => `$${dollars < 0.01 ? dollars.toFixed(3) : dollars.toFixed(2)}`;

const data = needData('greptile', ['summary.json']);
const summary = JSON.parse(await fs.readFile(path.join(data, 'summary.json'), 'utf8'));
const run = summary.find(r => r.config === 'oai2q' && r.cutoff === 0.6);
const caught = Math.round(100 * run.known / run.known_of), perPr = usd(run.cost / run.known_of);
const rows = [...PUBLISHED.map(r => ({ ...r, text: `${r.value}%` })), { name: 'Perch', perch: true, value: caught, text: `${caught}%`, extra: perPr }]
  .sort((a, b) => b.value - a.value);

const chart = colors => barChart(colors, {
  title: 'Perch on the Greptile benchmark',
  kicker: 'Greptile benchmark',
  headline: `Perch catches ${caught}% of the known bugs for ${perPr} a pull request`,
  subtitle: `${run.known_of} pull requests from Sentry, Cal.com, Grafana, Keycloak and Discourse, each with one known bug.`,
  columns: { value: 'Known bugs caught', extra: 'Cost of a pull request' },
  desc: `Known bugs caught on the Greptile benchmark, and what a pull request costs. ${rows.map(r => `${r.name}: ${r.text}, ${r.extra}.`).join(' ')}`,
  rows,
  footer: [
    `Perch: OpenAI's Decisions model at its default 60% floor, credited for flagging the function that holds the bug.`,
    `Perch's cost is the model's, measured on this run: ${usd(run.cost)} for all ${run.known_of}. Others: list prices, seat plans over 20 pull requests a developer a month.`,
    `Others' catch rates: greptile.com/benchmarks, ${PUBLISHED_DATE}, credited for a line comment that identifies the bug.`,
  ],
});

for (const [theme, colors] of Object.entries(THEMES)) {
  await fs.writeFile(path.join(root, '../../.github', `greptile-${theme}.svg`), chart(colors));
}
