import fs from 'node:fs/promises';
import merge from './merge.js';
import { fromEnv } from './env.js';
import { parseArgs } from './args.js';
import { interpolateAll } from './interpolate.js';
import { formatFor } from './formats/index.js';
import { Schema } from './schema/index.js';
import { ConfigError } from './errors.js';

/**
 * Loads a configuration in layers, each over the one before: `defaults`, each of `files` in order, the variables named with
 * `prefix`, then `argv`. The result is interpolated from `env` and, given a `schema`, checked against it.
 *
 * A file is a path, or `{ path, optional: true }` for one that may not exist.
 */
export async function loadConfig({ files = [], env = process.env, argv = [], prefix, schema, defaults = {} } = {}) {
  const layers = [defaults];

  for (const entry of files) {
    const { path, optional = false } = typeof entry === 'string' ? { path: entry } : entry;
    const layer = await readLayer(path, optional);
    if (layer) layers.push(layer);
  }
  if (prefix) layers.push(fromEnv(env, { prefix }));
  if (argv.length) layers.push(parseArgs(argv));

  const config = interpolateAll(merge({}, ...layers), env);
  if (!schema) return config;
  return (schema instanceof Schema ? schema : new Schema(schema)).validate(config);
}

async function readLayer(path, optional) {
  let text;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' && optional) return null;
    throw new ConfigError(`cannot read ${path}: ${err.message}`, { file: path, cause: err });
  }
  const parse = formatFor(path);
  return parse(text, path);
}

export default loadConfig;
