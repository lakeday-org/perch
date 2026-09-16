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
    expect(parseArgs(['hunt', 'owner/repo', '--paths', 'src,lib', '--budget=2', '--parallel', '3', '--force', '--json'])).toEqual({
      flags: { paths: 'src,lib', budget: '2', parallel: '3', force: true, json: true }, positional: ['hunt', 'owner/repo'] });
    expect(parseArgs(['refactor', 'src/metrics.ts', '--budget', '5', '--effort', 'low'])).toEqual({ flags: { budget: '5', effort: 'low' }, positional: ['refactor', 'src/metrics.ts'] });
    expect(parseArgs(['issues', '--closed', '--all']).flags).toEqual({ closed: true, all: true });
    expect(() => parseArgs(['scan', '--bogus'])).toThrow('unknown option --bogus');
    expect(() => parseArgs(['hunt', '--candidates', '2'])).toThrow('unknown option --candidates');
    expect(() => parseArgs(['hunt', '--model'])).toThrow('--model requires a value');
  });

  it('prints usage and rejects bad invocations', async () => {
    const { out, err, io } = capture();
    expect(await main(['--help'], io)).toBe(0);
    for (const verb of ['scan [target]', 'hunt [target]', 'issues [finding-id]', 'fix [path]', 'refactor [path]', 'report ']) expect(out[0]).toContain(verb);
    expect(out[0]).not.toContain('publish');
    expect(out[0]).not.toMatch(/^\s*design /m);
    expect(await main(['fix', '-h'], io)).toBe(0);
    expect(out.at(-1)).toContain('perch fix: Fix open defects in this checkout');
    expect(out.at(-1)).toContain('--budget');
    expect(await main(['refactor', '-h'], io)).toBe(0);
    expect(out.at(-1)).toContain('perch refactor: Simplify the riskiest methods the scan sees');
    expect(await main(['bogus'], io)).toBe(2);
    expect(await main(['design'], io)).toBe(2);
    expect(await main(['fix', '--budget', '0'], io)).toBe(2);
    expect(err.at(-1)).toContain('--budget must be a positive integer');
    expect(await main(['fix', '--effort', 'ultra'], io)).toBe(2);
    expect(err.at(-1)).toContain('--effort must be one of none, low, medium, high, xhigh, max');
    expect(await main(['refactor', 'abcd1234'], io)).toBe(2);
    expect(err.at(-1)).toContain('refactor takes a path');
    expect(await main(['report', 'owner/repo'], io)).toBe(2);
  });

  it('needs a TypeSafe key for hunt and an OpenAI key for fix and refactor, but none for scan, issues, or report', async () => {
    const repo = await makeFixture();
    cleanups.push(repo);
    const { out, err, io } = capture();
    expect(await main(['hunt', repo], io)).toBe(1);
    expect(err.at(-1)).toContain('TYPESAFE_API_KEY');
    expect(await main(['fix', '--out', join(repo, '.perch')], io)).toBe(1);
    expect(err.at(-1)).toContain('OPENAI_API_KEY');
    expect(await main(['refactor', 'src', '--out', join(repo, '.perch')], io)).toBe(1);
    expect(err.at(-1)).toContain('OPENAI_API_KEY');
    expect(await main(['scan', repo], io)).toBe(0);
    expect(out.at(-1)).toContain('src/clamp.js');
    expect(await main(['report', '--out', join(repo, '.perch')], io)).toBe(1);
    expect(err.at(-1)).toContain('no hunts found');
    expect(await main(['issues', '--out', join(repo, '.perch')], io)).toBe(0);
    expect(out.at(-1)).toContain('No hunted method');
  });

  it('lists issues and reports the latest hunt from the results directory', async () => {
    const repoRoot = await makeGraphFixture();
    cleanups.push(repoRoot);
    const repo = { root: repoRoot, revision: await revision(repoRoot), out: join(repoRoot, '.perch') };
    const hunt = await runHunt(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), systemOne: scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.8, kind_wrong_return: 0.6 } }), budget: 2 }));
    const { out, err, io } = capture();
    expect(await main(['report', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toContain('Hunted 2 methods');
    expect(await main(['report', '--out', repo.out, '--json'], io)).toBe(0);
    expect(JSON.parse(out.at(-1)).id).toBe(hunt.id);
    const [f] = hunt.visited;
    expect(await main(['issues', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toMatch(new RegExp(`${f.id}  f +src/a.js:\\d+ +wrong return 80% +minor +open`));
    expect(await main(['issues', f.id.slice(0, 5), '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toContain('Reachable defect: 80%');
    expect(out.at(-1)).toContain('wrong return 60%');
    expect(await main(['issues', '--out', repo.out, '--min', '90'], io)).toBe(0);
    expect(out.at(-1)).toContain('No hunted method has an issue at 90%');
  });

  it('bundles with esbuild into a loadable module', async () => {
    await promisify(execFile)('node', ['build.mjs'], { cwd: root });
    const bundle = await import(new URL('../dist/cli.mjs', import.meta.url).href);
    expect(typeof bundle.main).toBe('function');
  }, 60_000);
});
