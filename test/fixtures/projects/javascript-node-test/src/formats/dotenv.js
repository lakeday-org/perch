const LINE = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)?\s*$/;
const ESCAPES = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/**
 * A .env file. Values may be bare, 'single-quoted' as written, or "double-quoted" with \n, \t and \" escapes. A bare value ends
 * at " #", where a comment starts.
 */
export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const match = LINE.exec(raw);
    if (!match) continue;

    const [, key, rest = ''] = match;
    let value = rest.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = expandEscapes(value);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    out[key] = value;
  }
  return out;
}

function expandEscapes(value) {
  return value.replace(/\\([nrt"\\])/g, (_, c) => ESCAPES[c]);
}
