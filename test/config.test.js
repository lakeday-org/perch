import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredEnvironment } from '../src/config.js';
import { configuredSystemOne } from '../src/cloud-client.js';
import { main } from '../src/cli.js';

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
    const home = await configHome(`model = "jev-test"
organization = "org-test"
repository = "repo-test"
`);
    const env = await configuredEnvironment({ HOME: home, PERCH_API_KEY: 'perch_ci_test' });
    expect(env).toMatchObject({
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
    const home = await configHome('base_url = "https://api.example.com/v1/systemone"\nmodel = "jev-config"\n');
    const env = await configuredEnvironment({ HOME: home, PERCH_MODEL_ID: 'jev-env' });
    expect(env.PERCH_MODEL_ID).toBe('jev-env');
    expect(env.PERCH_BASE_URL).toBe('https://api.example.com/v1/systemone');
  });

  it('accepts comments and literal strings without reading a hash inside a URL as a comment', async () => {
    const home = await configHome('# Local defaults\nbase_url = "https://gateway.example.com/#preview" # endpoint\norganization = \'team-one\'\n');
    const env = await configuredEnvironment({ HOME: home });
    expect(env.PERCH_BASE_URL).toBe('https://gateway.example.com/#preview');
    expect(env.PERCH_ORGANIZATION).toBe('team-one');
  });

  it('reports invalid and unknown settings instead of silently using another endpoint', async () => {
    const home = await configHome('model = 12\n');
    await expect(configuredEnvironment({ HOME: home })).rejects.toThrow('model');
    await writeFile(join(home, '.perch', 'config.toml'), 'modle = "https://example.com"\n');
    await expect(configuredEnvironment({ HOME: home })).rejects.toThrow('Unknown setting modle');
    await writeFile(join(home, '.perch', 'config.toml'), 'model = [\n');
    await expect(configuredEnvironment({ HOME: home })).rejects.toThrow('Invalid');
    await writeFile(join(home, '.perch', 'config.toml'), 'model = "jev"\nmodel = "other"\n');
    await expect(configuredEnvironment({ HOME: home })).rejects.toThrow('Duplicate setting model');
  });

  it('keeps local commands usable with a bad config and reports it in doctor', async () => {
    const home = await configHome('modle = "https://example.com"\n');
    const output = [], errors = [];
    const io = { env: { HOME: home }, stdout: text => output.push(text), stderr: text => errors.push(text) };

    expect(await main(['issues', '--out', join(home, 'results')], io)).toBe(0);
    expect(output.at(-1)).toBe('Nothing matches.');
    expect(await main(['doctor', '--json', '--out', join(home, 'results')], io)).toBe(1);
    const doctor = JSON.parse(output.at(-1));
    expect(doctor.checks).toContainEqual(expect.objectContaining({ name: 'config', ok: false }));
    expect(doctor.checks.find(check => check.name === 'config').found).toContain('Unknown setting modle');
    expect(await main(['logout'], io)).toBe(0);
    expect(errors).not.toContainEqual(expect.stringContaining('perch:'));
  });
});
