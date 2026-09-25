import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredEnvironment } from '../src/config.js';
import { configuredSystemOne } from '../src/cloud-client.js';

const homes = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function configHome(content) {
  const home = await mkdtemp(join(tmpdir(), 'perch-config-'));
  homes.push(home);
  await mkdir(join(home, '.perch'));
  await writeFile(join(home, '.perch', 'config.toml'), content);
  return home;
}

describe('CLI configuration', () => {
  it('uses ~/.perch/config.toml for endpoint, model, and Cloud scope', async () => {
    const home = await configHome(`cloud_url = "https://cloud.example.com"
model = "jev-test"
organization = "org-test"
repository = "repo-test"
`);
    const env = await configuredEnvironment({ HOME: home, PERCH_TOKEN: 'perch_ci_test' });
    expect(env).toMatchObject({
      PERCH_CLOUD_URL: 'https://cloud.example.com',
      PERCH_MODEL_ID: 'jev-test',
      PERCH_ORGANIZATION: 'org-test',
      PERCH_REPOSITORY: 'repo-test',
    });

    const client = await configuredSystemOne({
      env,
      root: home,
      fetchImpl: async () => new Response(JSON.stringify({ model: 'jev-default', epoch: '1' })),
    });
    expect(client.id).toBe('jev-test');
  });

  it('lets environment values override the config file', async () => {
    const home = await configHome('cloud_url = "https://cloud.example.com"\nbase_url = "https://api.example.com/v1/systemone"\nmodel = "jev-config"\n');
    const env = await configuredEnvironment({
      HOME: home, PERCH_CLOUD_URL: 'https://override.example.com', PERCH_MODEL_ID: 'jev-env',
    });
    expect(env.PERCH_CLOUD_URL).toBe('https://override.example.com');
    expect(env.PERCH_MODEL_ID).toBe('jev-env');
    expect(env.PERCH_BASE_URL).toBe('https://api.example.com/v1/systemone');
  });

  it('reports invalid and unknown settings instead of silently using another endpoint', async () => {
    const home = await configHome('model = 12\n');
    await expect(configuredEnvironment({ HOME: home })).rejects.toThrow('model');
    await writeFile(join(home, '.perch', 'config.toml'), 'cluod_url = "https://example.com"\n');
    await expect(configuredEnvironment({ HOME: home })).rejects.toThrow('Unknown setting cluod_url');
    await writeFile(join(home, '.perch', 'config.toml'), 'cloud_url = [\n');
    await expect(configuredEnvironment({ HOME: home })).rejects.toThrow('Invalid');
  });
});
