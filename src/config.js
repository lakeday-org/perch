/** Local CLI defaults. Credentials live in the environment or the separate cloud login file. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

const settings = {
  cloud_url: 'PERCH_CLOUD_URL',
  organization: 'PERCH_ORGANIZATION',
  repository: 'PERCH_REPOSITORY',
  base_url: 'PERCH_BASE_URL',
  model: 'PERCH_MODEL_ID',
};

export const configPath = env => join(env.HOME || homedir(), '.perch', 'config.toml');

export async function configuredEnvironment(env) {
  const path = configPath(env);
  let content;
  try { content = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return env;
    throw new Error(`Could not read ${path}: ${error.message}`, { cause: error });
  }

  let config;
  try { config = parse(content); }
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
