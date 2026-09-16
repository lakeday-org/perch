import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { main, parseArgs } from '../src/cli.js';
import { revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { runHunt } from '../src/hunt.js';
import { fixtureOptions, makeFixture, makeGraphFixture, scriptedSystemOne } from './helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

function capture() {
  const out = [], err = [];
  return { out, err, io: { stdout: text => out.push(text), stderr: text => err.push(text), env: {} } };
}

describe('cli', () => {
  it('parses flags and positionals', () => {
    expect(parseArgs(['scan', 'owner/repo', '--paths', 'src,lib', '--budget=2', '--parallel', '3', '--force', '--json'])).toEqual({
      flags: { paths: 'src,lib', budget: '2', parallel: '3', force: true, json: true }, positional: ['scan', 'owner/repo'] });
    expect(parseArgs(['fix', 'src/metrics.ts', '--budget', '5', '--effort', 'low'])).toEqual({ flags: { budget: '5', effort: 'low' }, positional: ['fix', 'src/metrics.ts'] });
    expect(parseArgs(['issues', '--closed', '--all']).flags).toEqual({ closed: true, all: true });
    expect(() => parseArgs(['scan', '--bogus'])).toThrow('unknown option --bogus');
    expect(() => parseArgs(['scan', '--candidates', '2'])).toThrow('unknown option --candidates');
    expect(() => parseArgs(['fix', '--model'])).toThrow('--model requires a value');
  });

  it('has three commands and prints their usage', async () => {
    const { out, err, io } = capture();
    expect(await main(['--help'], io)).toBe(0);
    for (const verb of ['scan [target]', 'issues [finding-id]', 'fix [finding-id | path]']) expect(out[0]).toContain(verb);
    for (const gone of ['hunt', 'refactor', 'report', 'publish', 'design']) expect(out[0]).not.toMatch(new RegExp(`^\\s*${gone} `, 'm'));
    expect(await main(['fix', '-h'], io)).toBe(0);
    expect(out.at(-1)).toContain('perch fix: Work the open issues in this checkout');
    expect(out.at(-1)).toContain('--budget');
    expect(await main(['scan', '-h'], io)).toBe(0);
    expect(out.at(-1)).toContain('perch scan: Find the issues in a repository');
    for (const gone of ['hunt', 'refactor', 'report']) expect(await main([gone], io)).toBe(2);
    expect(await main(['fix', '--budget', '0'], io)).toBe(2);
    expect(err.at(-1)).toContain('--budget must be a positive integer');
    expect(await main(['fix', '--effort', 'ultra'], io)).toBe(2);
    expect(err.at(-1)).toContain('--effort must be one of none, low, medium, high, xhigh, max');
  });

  it('needs a TypeSafe key for scan and an OpenAI key for fix, but none for issues', async () => {
    const repo = await makeFixture();
    cleanups.push(repo);
    const { out, err, io } = capture();
    expect(await main(['scan', repo], io)).toBe(1);
    expect(err.at(-1)).toContain('TYPESAFE_API_KEY');
    expect(await main(['fix', '--out', join(repo, '.perch')], io)).toBe(1);
    expect(err.at(-1)).toContain('OPENAI_API_KEY');
    expect(await main(['issues', '--out', join(repo, '.perch')], io)).toBe(0);
    expect(out.at(-1)).toBe('No open issues.');
  });

  it('lists the issues a scan found, from the results directory', async () => {
    const repoRoot = await makeGraphFixture();
    cleanups.push(repoRoot);
    const repo = { root: repoRoot, revision: await revision(repoRoot), out: join(repoRoot, '.perch') };
    const hunt = await runHunt(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), systemOne: scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.8, kind_wrong_return: 0.6 } }), budget: 2 }));
    const { out, err, io } = capture();
    const [f] = hunt.visited;
    expect(await main(['issues', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toMatch(new RegExp(`${f.id}  f +src/a.js:\\d+ +wrong return value 80% +minor +open +-`));
    expect(out.at(-1)).not.toContain('Work');
    const code = await main(['issues', f.id.slice(0, 5), '--out', repo.out, '--verbose'], io);
    if (code !== 0) throw new Error(err.join('\n'));
    expect(out.at(-1)).toContain('Defect: 80%');
    expect(out.at(-1)).toContain('wrong return value 60%');
    expect(out.at(-1)).toContain('Metrics: risk');
    expect(await main(['issues', '--out', repo.out, '--min', '90'], io)).toBe(0);
    expect(out.at(-1)).toBe('No open issues at 90% or more.');
    expect(await main(['issues', '--out', repo.out, '--json'], io)).toBe(0);
    expect(JSON.parse(out.at(-1))[0].id).toBe(f.id);
  });

  it('bundles with esbuild into a loadable module', async () => {
    await promisify(execFile)('node', ['build.mjs'], { cwd: root });
    const bundle = await import(new URL('../dist/cli.mjs', import.meta.url).href);
    expect(typeof bundle.main).toBe('function');
  }, 60_000);
});
