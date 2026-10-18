import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Draws the README's ReviewBench chart, light and dark, into .github/. Perch's rows come from summary.json; the leaderboard's are
// the grounded scores review-bench.ai listed on the date below, so a new leaderboard means new rows and a new date here.
const root = path.dirname(fileURLToPath(import.meta.url));
const LEADERBOARD_DATE = 'October 17, 2026';
const LEADERBOARD = [
  { name: 'Laude RevEngine Prime', f1: 59.6, precision: 83.6, recall: 46.3 },
  { name: 'block/review', f1: 47.7, precision: 88.7, recall: 32.6 },
  { name: 'Klaussy', f1: 44.1, precision: 84.1, recall: 29.8 },
  { name: 'Copilot code review', f1: 40.1, precision: 87.8, recall: 26.0 },
  { name: 'DeepSeek Harness Reviewer', f1: 39.9, precision: 89.5, recall: 25.6 },
  { name: 'Devin AI', f1: 37.0, precision: 84.0, recall: 23.8 },
  { name: 'Qodo', f1: 35.1, precision: 85.3, recall: 22.1 },
  { name: 'Codex', f1: 30.4, precision: 86.0, recall: 18.5 },
  { name: 'Cubic', f1: 27.3, precision: 85.5, recall: 16.3 },
  { name: 'Greptile', f1: 27.2, precision: 86.1, recall: 16.2 },
  { name: 'Cursor', f1: 17.3, precision: 87.7, recall: 9.6 },
];
const MODELS = { jev: 'Jev 1.14', luna: 'GPT-6 Luna' };

const percent = value => Math.round(value * 1000) / 10;
const summary = JSON.parse(await fs.readFile(path.join(root, 'summary.json'), 'utf8'));
const rows = [...LEADERBOARD, ...summary.map(r => ({ name: MODELS[r.provider], perch: true, f1: percent(r.f1), precision: percent(r.precision), recall: percent(r.recall) }))]
  .sort((a, b) => b.f1 - a.f1);

// Perch's amber and a recessive gray, checked against GitHub's light and dark page colors. The gray sits under 3:1 on purpose,
// which is why every bar carries its value.
const THEMES = {
  light: { accent: '#c27a12', other: '#b9b8b0', washOpacity: 0.09, primary: '#1f2328', secondary: '#59636e', muted: '#818b98', track: '#f1f2f4', baseline: '#c9cfd6' },
  dark: { accent: '#cc8218', other: '#5a5e66', washOpacity: 0.12, primary: '#f0f6fc', secondary: '#9198a1', muted: '#7d8590', track: '#1a1f27', baseline: '#30363d' },
};
const W = 880, ROW = 30, BAR = 12, R = 4, PANEL = 170, TOP = 128;
const PANELS = [{ key: 'f1', label: 'F1', x: 214 }, { key: 'precision', label: 'Precision', x: 434 }, { key: 'recall', label: 'Recall', x: 654 }];
const bottom = TOP + rows.length * ROW, H = bottom + 64;
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;

// Square at the baseline, rounded at the value.
const bar = (x, y, w) => w <= R ? `M${x},${y}h${w}v${BAR}h${-w}z`
  : `M${x},${y}h${w - R}a${R},${R} 0 0 1 ${R},${R}v${BAR - 2 * R}a${R},${R} 0 0 1 ${-R},${R}h${-(w - R)}z`;

function chart(t) {
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">`,
    '<title id="title">Perch on ReviewBench</title>',
    `<desc id="desc">F1, precision and recall for perch beside the ReviewBench leaderboard. ${rows.map(r => `${r.perch ? 'Perch with ' : ''}${r.name}: F1 ${r.f1}%, precision ${r.precision}%, recall ${r.recall}%.`).join(' ')}</desc>`,
    `<style>text{font-family:${FONT}}.n{font-variant-numeric:tabular-nums}</style>`,
    `<text x="8" y="30" font-size="20" font-weight="600" fill="${t.primary}">Perch on ReviewBench</text>`,
    `<text x="8" y="54" font-size="13" fill="${t.secondary}">F1, precision and recall beside the ReviewBench leaderboard, GitHub's benchmark for AI code review</text>`,
    `<rect x="8" y="72" width="10" height="10" rx="2" fill="${t.accent}"/><text x="24" y="81" font-size="12" fill="${t.secondary}">Perch</text>`,
    `<rect x="76" y="72" width="10" height="10" rx="2" fill="${t.other}"/><text x="92" y="81" font-size="12" fill="${t.secondary}">Leaderboard reviewers</text>`,
  ];
  for (const panel of PANELS) {
    out.push(`<text x="${panel.x}" y="${TOP - 12}" font-size="12" font-weight="600" fill="${t.secondary}">${panel.label}</text>`);
    // No gridlines: they would cross the value labels. The track behind each bar shows the scale.
    out.push(`<line x1="${panel.x}" y1="${TOP}" x2="${panel.x}" y2="${bottom}" stroke="${t.baseline}" stroke-width="1"/>`);
    out.push(`<text class="n" x="${panel.x}" y="${bottom + 16}" font-size="11" fill="${t.muted}">0%</text>`);
    out.push(`<text class="n" x="${panel.x + PANEL}" y="${bottom + 16}" font-size="11" text-anchor="end" fill="${t.muted}">100%</text>`);
  }
  rows.forEach((row, index) => {
    const y = TOP + index * ROW, mid = y + ROW / 2;
    if (row.perch) out.push(`<rect x="0" y="${y + 2}" width="${W}" height="${ROW - 4}" rx="6" fill="${t.accent}" fill-opacity="${t.washOpacity}"/>`);
    out.push(row.perch
      ? `<text x="8" y="${mid + 4.5}" font-size="13" fill="${t.primary}"><tspan font-weight="600">Perch</tspan> · ${row.name}</text>`
      : `<text x="8" y="${mid + 4.5}" font-size="13" fill="${t.secondary}">${row.name}</text>`);
    for (const panel of PANELS) {
      const value = row[panel.key], w = PANEL * value / 100;
      out.push(`<path d="${bar(panel.x, mid - BAR / 2, PANEL)}" fill="${t.track}"/>`);
      out.push(`<path d="${bar(panel.x, mid - BAR / 2, w)}" fill="${row.perch ? t.accent : t.other}"/>`);
      out.push(`<text class="n" x="${panel.x + w + 6}" y="${mid + 4}" font-size="12"${row.perch ? ' font-weight="600"' : ''} fill="${row.perch ? t.primary : t.secondary}">${value.toFixed(1)}%</text>`);
    }
  });
  out.push(`<text x="8" y="${H - 14}" font-size="11" fill="${t.muted}">Leaderboard: review-bench.ai, grounded scores, ${LEADERBOARD_DATE}. Perch: .benchmarks/reviewbench in this repository.</text>`, '</svg>');
  return out.join('\n') + '\n';
}

for (const [theme, colors] of Object.entries(THEMES)) {
  await fs.writeFile(path.join(root, '../../.github', `reviewbench-${theme}.svg`), chart(colors));
}
