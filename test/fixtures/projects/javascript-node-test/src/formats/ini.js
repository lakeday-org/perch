import { coerce } from '../env.js';
import { ConfigError } from '../errors.js';

/** An INI file: `[section]` and `[section.sub]` headers, `key = value` lines, and `;` or `#` comments. */
export default function parseIni(text) {
  const out = {};
  let section = out;

  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;

    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = out;
      for (const part of header[1].split('.')) section = section[part.trim()] ??= {};
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) throw new ConfigError(`line ${index + 1}: expected key = value, got ${JSON.stringify(line)}`, { line: index + 1 });
    section[line.slice(0, eq).trim()] = unquote(line.slice(eq + 1).trim());
  }
  return out;
}

function unquote(value) {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) return value.slice(1, -1);
  return coerce(value);
}
