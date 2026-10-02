import { coerce, setPath } from './env.js';

/**
 * Flags as a nested object: `--port=80`, `--port 80`, `--verbose`, `--no-color` and dotted keys such as `--db.pool=4`. Anything
 * that is not a flag is passed over, and everything after `--` is left alone.
 */
export function parseArgs(argv) {
  const out = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    if (!arg.startsWith('--')) continue;

    let [key, value] = splitOnce(arg.slice(2), '=');
    if (value !== undefined) {
      value = coerce(value);
    } else if (key.startsWith('no-')) {
      key = key.slice(3);
      value = false;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      value = coerce(argv[++i]);
    } else {
      value = true;
    }
    setPath(out, key.split('.'), value);
  }
  return out;
}

function splitOnce(text, separator) {
  const at = text.indexOf(separator);
  return at === -1 ? [text, undefined] : [text.slice(0, at), text.slice(at + separator.length)];
}
