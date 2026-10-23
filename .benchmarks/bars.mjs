// The horizontal bar chart the README's benchmark charts are drawn in, light and dark: perch's rows in amber on a wash, the
// other reviewers' in gray, highest first, each bar carrying its value.

// Perch's amber and a recessive gray, checked against GitHub's light and dark page colors. The gray sits under 3:1 on purpose,
// which is why every bar carries its value.
export const THEMES = {
  light: { accent: '#c27a12', other: '#b9b8b0', washOpacity: 0.09, primary: '#1f2328', secondary: '#59636e', muted: '#818b98', track: '#f1f2f4', baseline: '#c9cfd6' },
  dark: { accent: '#cc8218', other: '#5a5e66', washOpacity: 0.12, primary: '#f0f6fc', secondary: '#9198a1', muted: '#7d8590', track: '#1a1f27', baseline: '#30363d' },
};
const W = 880, ROW = 30, BAR = 14, R = 4, X = 214, SCALE = 580, TOP = 112;
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Square at the baseline, rounded at the value.
const bar = (x, y, w) => w <= R ? `M${x},${y}h${w}v${BAR}h${-w}z`
  : `M${x},${y}h${w - R}a${R},${R} 0 0 1 ${R},${R}v${BAR - 2 * R}a${R},${R} 0 0 1 ${-R},${R}h${-(w - R)}z`;

/**
 * One theme's SVG. Each row has a name, a value in percent, the text printed after its bar, and for perch's rows `perch: true`
 * and a `note` printed after the value. Rows are drawn in the order given.
 */
export function barChart(t, { title, heading, subtitle, others, desc, rows, footer }) {
  const bottom = TOP + rows.length * ROW, H = bottom + 48 + 16 * footer.length;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${escape(title)}</title>`,
    `<desc id="desc">${escape(desc)}</desc>`,
    `<style>text{font-family:${FONT}}.n{font-variant-numeric:tabular-nums}</style>`,
    `<text x="8" y="30" font-size="20" font-weight="600" fill="${t.primary}">${escape(heading)}</text>`,
    `<text x="8" y="54" font-size="13" fill="${t.secondary}">${escape(subtitle)}</text>`,
    `<rect x="8" y="72" width="10" height="10" rx="2" fill="${t.accent}"/><text x="24" y="81" font-size="12" fill="${t.secondary}">Perch</text>`,
    `<rect x="76" y="72" width="10" height="10" rx="2" fill="${t.other}"/><text x="92" y="81" font-size="12" fill="${t.secondary}">${escape(others)}</text>`,
    // No gridlines: they would cross the value labels. The track behind each bar shows the scale.
    `<line x1="${X}" y1="${TOP}" x2="${X}" y2="${bottom}" stroke="${t.baseline}" stroke-width="1"/>`,
    `<text class="n" x="${X}" y="${bottom + 16}" font-size="11" fill="${t.muted}">0%</text>`,
    `<text class="n" x="${X + SCALE}" y="${bottom + 16}" font-size="11" text-anchor="end" fill="${t.muted}">100%</text>`,
  ];
  rows.forEach((row, index) => {
    const y = TOP + index * ROW, mid = y + ROW / 2, w = +(SCALE * row.value / 100).toFixed(2);
    if (row.perch) out.push(`<rect x="0" y="${y + 2}" width="${W}" height="${ROW - 4}" rx="6" fill="${t.accent}" fill-opacity="${t.washOpacity}"/>`);
    out.push(row.perch
      ? `<text x="8" y="${mid + 4.5}" font-size="13" fill="${t.primary}"><tspan font-weight="600">Perch</tspan> · ${escape(row.name)}</text>`
      : `<text x="8" y="${mid + 4.5}" font-size="13" fill="${t.secondary}">${escape(row.name)}</text>`);
    out.push(`<path d="${bar(X, mid - BAR / 2, SCALE)}" fill="${t.track}"/>`);
    out.push(`<path d="${bar(X, mid - BAR / 2, w)}" fill="${row.perch ? t.accent : t.other}"/>`);
    const note = row.note ? `<tspan font-weight="400" fill="${t.secondary}"> · ${escape(row.note)}</tspan>` : '';
    out.push(`<text class="n" x="${+(X + w + 8).toFixed(2)}" y="${mid + 4.5}" font-size="13"${row.perch ? ' font-weight="600"' : ''} fill="${row.perch ? t.primary : t.secondary}">${escape(row.text)}${note}</text>`);
  });
  footer.forEach((line, index) => out.push(`<text x="8" y="${bottom + 50 + 16 * index}" font-size="11" fill="${t.muted}">${escape(line)}</text>`));
  out.push('</svg>');
  return out.join('\n') + '\n';
}
