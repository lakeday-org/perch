/** Local CLI defaults. Credentials live in the environment or the separate cloud login file. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const settings = {
  cloud_url: 'PERCH_CLOUD_URL',
  organization: 'PERCH_ORGANIZATION',
  repository: 'PERCH_REPOSITORY',
  base_url: 'PERCH_BASE_URL',
  model: 'PERCH_MODEL_ID',
};

export const configPath = env => join(env.HOME || homedir(), '.perch', 'config.toml');

/** The five supported string assignments, rather than a general TOML implementation. */
function parseConfig(content) {
  const config = Object.create(null);
  for (const [index, raw] of content.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-z_]+)\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$/.exec(line);
    if (!match) {
      const name = /^([a-z_]+)\s*=/.exec(line)?.[1];
      throw new Error(name ? `${name} on line ${index + 1} must be a quoted string` : `line ${index + 1} must be a string assignment`);
    }
    const [, name, quoted] = match;
    if (!settings[name]) throw new Error(`Unknown setting ${name}`);
    if (Object.hasOwn(config, name)) throw new Error(`Duplicate setting ${name}`);
    try { config[name] = quoted.startsWith('"') ? JSON.parse(quoted) : quoted.slice(1, -1); }
    catch (error) { throw new Error(`${name} on line ${index + 1}: ${error.message}`, { cause: error }); }
  }
  return config;
}

export async function configuredEnvironment(env) {
  const path = configPath(env);
  let content;
  try { content = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return env;
    throw new Error(`Could not read ${path}: ${error.message}`, { cause: error });
  }

  let config;
  try { config = parseConfig(content); }
  catch (error) { throw new Error(`Invalid ${path}: ${error.message}`, { cause: error }); }

  const resolved = { ...env };
  for (const [name, value] of Object.entries(config)) {
    const variable = settings[name];
    if (!variable) throw new Error(`Unknown setting ${name} in ${path}.`);
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${name} in ${path} must be a nonempty string.`);
    }
    if (!resolved[variable]) resolved[variable] = value;
  }
  return resolved;
}
