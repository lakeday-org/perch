import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Draws the README's ReviewBench recall chart, light and dark, into .github/. Perch's rows come from summary.json; the
// leaderboard's are the grounded recall review-bench.ai listed on the date below, so a new leaderboard means new rows and a new
// date here.
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
const MODELS = { jev: 'Jev 1.14', luna: 'OpenAI Decisions' };

const summary = JSON.parse(await fs.readFile(path.join(root, 'summary.json'), 'utf8'));
const rows = [...LEADERBOARD, ...summary.map(r => ({ name: MODELS[r.provider], perch: true, recall: Math.round(r.recall * 1000) / 10 }))]
  .sort((a, b) => b.recall - a.recall);

// Perch's amber and a recessive gray, checked against GitHub's light and dark page colors. The gray sits under 3:1 on purpose,
// which is why every bar carries its value.
const THEMES = {
  light: { accent: '#c27a12', other: '#b9b8b0', washOpacity: 0.09, primary: '#1f2328', secondary: '#59636e', muted: '#818b98', track: '#f1f2f4', baseline: '#c9cfd6' },
  dark: { accent: '#cc8218', other: '#5a5e66', washOpacity: 0.12, primary: '#f0f6fc', secondary: '#9198a1', muted: '#7d8590', track: '#1a1f27', baseline: '#30363d' },
};
const W = 880, ROW = 30, BAR = 14, R = 4, X = 214, SCALE = 580, TOP = 112;
const bottom = TOP + rows.length * ROW, H = bottom + 64;
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;

// Square at the baseline, rounded at the value.
const bar = (x, y, w) => w <= R ? `M${x},${y}h${w}v${BAR}h${-w}z`
  : `M${x},${y}h${w - R}a${R},${R} 0 0 1 ${R},${R}v${BAR - 2 * R}a${R},${R} 0 0 1 ${-R},${R}h${-(w - R)}z`;

function chart(t) {
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">`,
    '<title id="title">Perch on ReviewBench: recall</title>',
    `<desc id="desc">Recall on ReviewBench for perch beside the reviewers on its leaderboard, highest first. ${rows.map(r => `${r.perch ? 'Perch with ' : ''}${r.name}: ${r.recall}%.`).join(' ')}</desc>`,
    `<style>text{font-family:${FONT}}.n{font-variant-numeric:tabular-nums}</style>`,
    `<text x="8" y="30" font-size="20" font-weight="600" fill="${t.primary}">Perch on ReviewBench</text>`,
    `<text x="8" y="54" font-size="13" fill="${t.secondary}">Recall</text>`,
    `<rect x="8" y="72" width="10" height="10" rx="2" fill="${t.accent}"/><text x="24" y="81" font-size="12" fill="${t.secondary}">Perch</text>`,
    `<rect x="76" y="72" width="10" height="10" rx="2" fill="${t.other}"/><text x="92" y="81" font-size="12" fill="${t.secondary}">Leaderboard reviewers</text>`,
    // No gridlines: they would cross the value labels. The track behind each bar shows the scale.
    `<line x1="${X}" y1="${TOP}" x2="${X}" y2="${bottom}" stroke="${t.baseline}" stroke-width="1"/>`,
    `<text class="n" x="${X}" y="${bottom + 16}" font-size="11" fill="${t.muted}">0%</text>`,
    `<text class="n" x="${X + SCALE}" y="${bottom + 16}" font-size="11" text-anchor="end" fill="${t.muted}">100%</text>`,
  ];
  rows.forEach((row, index) => {
    const y = TOP + index * ROW, mid = y + ROW / 2, w = SCALE * row.recall / 100;
    if (row.perch) out.push(`<rect x="0" y="${y + 2}" width="${W}" height="${ROW - 4}" rx="6" fill="${t.accent}" fill-opacity="${t.washOpacity}"/>`);
    out.push(row.perch
      ? `<text x="8" y="${mid + 4.5}" font-size="13" fill="${t.primary}"><tspan font-weight="600">Perch</tspan> · ${row.name}</text>`
      : `<text x="8" y="${mid + 4.5}" font-size="13" fill="${t.secondary}">${row.name}</text>`);
    out.push(`<path d="${bar(X, mid - BAR / 2, SCALE)}" fill="${t.track}"/>`);
    out.push(`<path d="${bar(X, mid - BAR / 2, w)}" fill="${row.perch ? t.accent : t.other}"/>`);
    out.push(`<text class="n" x="${X + w + 8}" y="${mid + 4.5}" font-size="13"${row.perch ? ' font-weight="600"' : ''} fill="${row.perch ? t.primary : t.secondary}">${row.recall.toFixed(1)}%</text>`);
  });
  out.push(`<text x="8" y="${H - 14}" font-size="11" fill="${t.muted}">Leaderboard: review-bench.ai, grounded recall, ${LEADERBOARD_DATE}. Perch: .benchmarks/reviewbench in this repository.</text>`, '</svg>');
  return out.join('\n') + '\n';
}

for (const [theme, colors] of Object.entries(THEMES)) {
  await fs.writeFile(path.join(root, '../../.github', `reviewbench-${theme}.svg`), chart(colors));
}
