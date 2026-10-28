import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { barChart, THEMES } from '../bars.mjs';
import { needData } from '../data.mjs';

// Draws the README's ReviewBench recall chart, light and dark, into .github/, beside what a pull request costs with each reviewer.
// Perch's rows are the reruns on OpenAI's Decisions model and on Jev at a 60% floor, from rerun-summary.json and
// rerun-jev-summary.json, each with the model's cost measured on that run. The leaderboard's are the grounded recall
// review-bench.ai listed on the date below, so a new leaderboard means new rows and a new date here. Their costs are list prices,
// a seat plan divided over 20 pull requests a developer a month; a reviewer with no public price says so.
const root = path.dirname(fileURLToPath(import.meta.url));
const LEADERBOARD_DATE = 'October 17, 2026';
const UNPUBLISHED = 'not published';
const LEADERBOARD = [
  { name: 'Laude RevEngine Prime', recall: 46.3, extra: UNPUBLISHED },
  { name: 'block/review', recall: 32.6, extra: UNPUBLISHED },
  { name: 'Klaussy', recall: 29.8, extra: UNPUBLISHED },
  // Code review draws on a plan's usage credits, and GitHub gives no cost for one (github.com/features/copilot/plans).
  { name: 'Copilot code review', recall: 26.0, extra: 'usage credits' },
  { name: 'DeepSeek Harness Reviewer', recall: 25.6, extra: UNPUBLISHED },
  // Teams, $40 a developer seat (devin.ai/pricing, October 23, 2026).
  { name: 'Devin AI', recall: 23.8, extra: '~$2' },
  // About 18 reviews from 2,500 credits at $0.012 each (qodo.ai/pricing, October 23, 2026).
  { name: 'Qodo', recall: 22.1, extra: '~$1.70' },
  // ChatGPT Business, $25 a user a month (learn.chatgpt.com/docs/pricing, October 23, 2026).
  { name: 'Codex', recall: 18.5, extra: '~$1.25' },
  // Team, $40 a developer a month (cubic.dev/pricing, October 23, 2026).
  { name: 'Cubic', recall: 16.3, extra: '~$2' },
  // $30 a seat with 50 reviews (greptile.com/pricing, October 3, 2026).
  { name: 'Greptile', recall: 16.2, extra: '~$1' },
  // Bugbot comes with Cursor's Teams plan, $30 a seat (cursor.com/pricing, October 23, 2026).
  { name: 'Cursor', recall: 9.6, extra: '~$1.50' },
];
const RUNS = [['rerun-summary.json', 'OpenAI Decisions'], ['rerun-jev-summary.json', 'Jev']];

const data = needData('reviewbench', ['manifest.json', ...RUNS.map(([file]) => file)]);
const { selected_prs: selected } = JSON.parse(await fs.readFile(path.join(data, 'manifest.json'), 'utf8'));
const pct = x => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
const perch = await Promise.all(RUNS.map(async ([file, model]) => {
  const summary = JSON.parse(await fs.readFile(path.join(data, file), 'utf8')), run = summary.cutoffs.find(c => c.cutoff === 0.6);
  return { name: `Perch · ${model}`, perch: true, value: Math.round(run.total.recall * 1000) / 10, text: pct(run.total.recall),
    extra: `$${(summary.cost_usd / summary.scanned_prs).toFixed(3)}`, precision: pct(run.total.precision), scanned: summary.scanned_prs };
}));
const rows = [...LEADERBOARD.map(r => ({ name: r.name, value: r.recall, text: `${r.recall.toFixed(1)}%`, extra: r.extra })), ...perch]
  .sort((a, b) => b.value - a.value);

const chart = colors => barChart(colors, {
  title: 'Perch on ReviewBench',
  heading: 'ReviewBench',
  subtitle: `Recall on GitHub's benchmark of ${selected} pull requests, against the findings of a human review, and the cost of a pull request.`,
  columns: { value: 'Recall', extra: 'Cost of a pull request' },
  desc: `Recall on ReviewBench for perch beside the reviewers on its leaderboard, highest first, and what a pull request costs. ${rows.map(r => `${r.name}: ${r.text}, ${r.extra}.`).join(' ')}`,
  rows,
  footer: [
    `Perch at a 60% floor, scored per function: ${perch.map(p => `${p.precision} precision on ${p.name.slice(8)}`).join(' and ')}.`,
    `Perch's cost is the model's, measured on each run over ${perch[0].scanned} pull requests.`,
    `Leaderboard: review-bench.ai, grounded recall, ${LEADERBOARD_DATE}, scored on review comments.`,
    'Their costs are list prices, with seat plans divided over 20 pull requests a developer a month.',
  ],
});

for (const [theme, colors] of Object.entries(THEMES)) {
  await fs.writeFile(path.join(root, '../../.github', `reviewbench-${theme}.svg`), chart(colors));
}
