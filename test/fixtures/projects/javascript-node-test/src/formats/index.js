import { extname } from 'node:path';
import parseJson from './json.js';
import parseIni from './ini.js';
import { parseDotenv } from './dotenv.js';
import { ConfigError } from '../errors.js';

export { default as json } from './json.js';
export { default as ini } from './ini.js';
export { parseDotenv as dotenv } from './dotenv.js';

const BY_EXTENSION = {
  '.json': parseJson,
  '.jsonc': parseJson,
  '.ini': parseIni,
  '.cfg': parseIni,
  '.env': parseDotenv,
};

/** The parser for a file, by its extension. `.env`, `.env.local` and the like are all dotenv. */
export function formatFor(file) {
  const base = file.split('/').at(-1);
  const ext = base.startsWith('.env') ? '.env' : extname(base).toLowerCase();
  const parse = BY_EXTENSION[ext];
  if (!parse) throw new ConfigError(`no parser for ${file}; stratum reads ${Object.keys(BY_EXTENSION).join(', ')}`, { file });
  return parse;
}
