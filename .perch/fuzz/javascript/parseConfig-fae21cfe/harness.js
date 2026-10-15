import { configuredEnvironment } from './src/config.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function runConfigured(content, env, mode) {
  const home = await mkdtemp(join(tmpdir(), 'parse-config-'));
  try {
    if (mode === 'read_error') {
      await writeFile(join(home, '.perch'), 'not a directory', 'utf8');
    } else if (mode !== 'missing') {
      await mkdir(join(home, '.perch'), { recursive: true });
      await writeFile(join(home, '.perch', 'config.toml'), content, 'utf8');
    }
    const result = await configuredEnvironment({ ...env, HOME: home });
    const { HOME, ...stableResult } = result;
    return stableResult;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
export async function fuzz(v) {
  const mode = v.case === 'configured_environment_missing' ? 'missing' : v.case === 'configured_environment_read_error' ? 'read_error' : 'file';
  return runConfigured(v.content, v.env, mode);
}