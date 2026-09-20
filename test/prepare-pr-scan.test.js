import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { initRepo } from './helpers.js';
import { analyzeTree } from '../src/analyze.js';
import { createSourceAnalyzer } from '../src/analysis.js';

const exec = promisify(execFile);
const script = resolve('.github/scripts/prepare-pr-scan.sh');
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'perch-approved-'));
  cleanups.push(root);
  const repo = join(root, 'remote'), bin = join(root, 'bin');
  await mkdir(repo);
  await mkdir(bin);
  await writeFile(join(repo, 'source.js'), 'export function answer() { return 42; }\n');
  await initRepo(repo);
  const base = await revision(repo);
  await writeFile(join(repo, '.env'), 'PERCH_BASE_URL=https://untrusted.invalid\n');
  await writeFile(join(repo, 'package.json'), '{"scripts":{"prepare":"exit 99"}}');
  await git(['add', '.'], repo);
  await git(['commit', '-qm', 'untrusted files'], repo);
  const head = await revision(repo);
  await git(['update-ref', 'refs/pull/82/head', head], repo);
  const json = join(root, 'pr.json');
  await writeFile(json, JSON.stringify({ state: 'open', head: { sha: head }, base: { sha: base, repo: { full_name: 'example/perch' } } }));
  await writeFile(join(bin, 'gh'), '#!/bin/sh\ncat "$PR_JSON"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PR_JSON: json, PR_NUMBER: '82', PR_SHA: head,
    GITHUB_REPOSITORY: 'example/perch', RUNNER_TEMP: root, GITHUB_OUTPUT: join(root, 'output'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${repo}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/example/perch.git' };
  return { root, repo, env, base, head };
}

it('prepares the exact commit without materializing executable files, and remains analyzable', async () => {
  const { root, env, base, head } = await fixture();
  await exec('bash', [script], { env });
  const outputs = Object.fromEntries((await readFile(env.GITHUB_OUTPUT, 'utf8')).trim().split('\n').map(line => line.split('=')));
  expect(outputs.base_sha).toBe(base);
  expect(await revision(outputs.target)).toBe(head);
  expect(await readdir(outputs.target)).toEqual(['.git']);
  const scan = await analyzeTree({ root: outputs.target, revision: head, out: join(root, 'results'), analyzer: createSourceAnalyzer() });
  expect(scan.files.map(file => file.path)).toEqual(['source.js']);
});

it('rejects malformed inputs and a head that changed before approval', async () => {
  const { env } = await fixture();
  for (const override of [{ PR_NUMBER: '82; echo unsafe' }, { PR_SHA: '--help' }, { PR_SHA: 'a'.repeat(40) }]) {
    await expect(exec('bash', [script], { env: { ...env, ...override } })).rejects.toThrow();
  }
  await expect(readFile(env.GITHUB_OUTPUT)).rejects.toThrow();
});

it('rejects a head that changed between the API response and fetch', async () => {
  const { env, repo, base } = await fixture();
  await git(['update-ref', 'refs/pull/82/head', base], repo);
  await expect(exec('bash', [script], { env })).rejects.toThrow('PR changed during preparation');
  await expect(readFile(env.GITHUB_OUTPUT)).rejects.toThrow();
});

it('rejects closed PRs before preparing a scan', async () => {
  const { env } = await fixture();
  const pr = JSON.parse(await readFile(env.PR_JSON, 'utf8'));
  await writeFile(env.PR_JSON, JSON.stringify({ ...pr, state: 'closed' }));
  await expect(exec('bash', [script], { env })).rejects.toThrow('PR is closed');
  await expect(readFile(env.GITHUB_OUTPUT)).rejects.toThrow();
});
