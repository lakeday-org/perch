// The horizontal bar chart the README's benchmark charts are drawn in, light and dark: a title, then one row a reviewer,
// highest first, perch's in amber on a wash and the others in gray, each bar carrying its value and, when the chart has one,
// a second column such as the cost of a pull request.

// Perch's amber and a recessive gray, checked against GitHub's light and dark page colors. The gray sits under 3:1 on purpose,
// which is why every bar carries its value.
export const THEMES = {
  light: { accent: '#c27a12', other: '#b9b8b0', washOpacity: 0.1, primary: '#1f2328', secondary: '#59636e', muted: '#818b98', track: '#f1f2f4', rule: '#d1d9e0' },
  dark: { accent: '#e0942b', other: '#5a5e66', washOpacity: 0.14, primary: '#f0f6fc', secondary: '#9198a1', muted: '#7d8590', track: '#1a1f27', rule: '#30363d' },
};
const W = 880, PAD = 16, ROW = 38, BAR = 18, R = 5, TOP = 124;
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Square at the baseline, rounded at the value.
const bar = (x, y, w) => w <= R ? `M${x},${y}h${w}v${BAR}h${-w}z`
  : `M${x},${y}h${w - R}a${R},${R} 0 0 1 ${R},${R}v${BAR - 2 * R}a${R},${R} 0 0 1 ${-R},${R}h${-(w - R)}z`;

/**
 * One theme's SVG. `heading` and `subtitle` say what is measured; `columns` heads the bars and, when `columns.extra` is set,
 * a right-hand column filled from each row's `extra`. Each row has a name, a value in percent, the text printed after its bar,
 * and `perch: true` on perch's. Rows are drawn in the order given; `footer` lines go under them.
 */
export function barChart(t, { title, heading, subtitle, columns, desc, rows, footer }) {
  // The bars start past the longest name, at about 7.6 pixels a character of 15-pixel text.
  const X = Math.max(196, Math.round(PAD + 24 + 7.6 * Math.max(...rows.map(row => row.name.length))));
  const scale = columns.extra ? 460 : W - PAD - 40 - X, bottom = TOP + rows.length * ROW, H = bottom + 30 + 17 * footer.length;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${escape(title)}</title>`,
    `<desc id="desc">${escape(desc)}</desc>`,
    `<style>text{font-family:${FONT}}.n{font-variant-numeric:tabular-nums}</style>`,
    `<text x="${PAD}" y="34" font-size="22" font-weight="700" fill="${t.primary}">${escape(heading)}</text>`,
    `<text x="${PAD}" y="60" font-size="14" fill="${t.secondary}">${escape(subtitle)}</text>`,
    `<line x1="${PAD}" y1="82" x2="${W - PAD}" y2="82" stroke="${t.rule}" stroke-width="1"/>`,
    `<text x="${X}" y="108" font-size="12" font-weight="600" fill="${t.muted}">${escape(columns.value)}</text>`,
    ...(columns.extra ? [`<text x="${W - PAD}" y="108" font-size="12" font-weight="600" text-anchor="end" fill="${t.muted}">${escape(columns.extra)}</text>`] : []),
  ];
  rows.forEach((row, index) => {
    const y = TOP + index * ROW, mid = y + ROW / 2, w = +(scale * row.value / 100).toFixed(2), base = mid + 5;
    if (row.perch) out.push(`<rect x="4" y="${y + 2}" width="${W - 8}" height="${ROW - 4}" rx="8" fill="${t.accent}" fill-opacity="${t.washOpacity}"/>`);
    out.push(`<text x="${PAD}" y="${base}" font-size="15"${row.perch ? ' font-weight="700"' : ''} fill="${row.perch ? t.primary : t.secondary}">${escape(row.name)}</text>`);
    out.push(`<path d="${bar(X, mid - BAR / 2, scale)}" fill="${t.track}"/>`);
    out.push(`<path d="${bar(X, mid - BAR / 2, w)}" fill="${row.perch ? t.accent : t.other}"/>`);
    out.push(`<text class="n" x="${+(X + w + 10).toFixed(2)}" y="${base}" font-size="15" font-weight="${row.perch ? 700 : 600}" fill="${row.perch ? t.primary : t.secondary}">${escape(row.text)}</text>`);
    if (columns.extra) out.push(`<text class="n" x="${W - PAD}" y="${base}" font-size="15" text-anchor="end" font-weight="${row.perch ? 700 : 400}" fill="${row.perch ? t.accent : t.secondary}">${escape(row.extra ?? '')}</text>`);
  });
  footer.forEach((line, index) => out.push(`<text x="${PAD}" y="${bottom + 26 + 17 * index}" font-size="11.5" fill="${t.muted}">${escape(line)}</text>`));
  out.push('</svg>');
  return out.join('\n') + '\n';
}
