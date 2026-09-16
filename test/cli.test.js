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
import { scanRepository } from '../src/hunt.js';
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
    expect(parseArgs(['scan', 'owner/repo', '--paths', 'src,lib', '--parallel', '3', '--force', '--json'])).toEqual({
      flags: { paths: 'src,lib', parallel: '3', force: true, json: true }, positional: ['scan', 'owner/repo'] });
    expect(parseArgs(['fix', 'src/metrics.ts', '--budget', '5', '--effort', 'low'])).toEqual({ flags: { budget: '5', effort: 'low' }, positional: ['fix', 'src/metrics.ts'] });
    expect(parseArgs(['issues', '--closed', '--all']).flags).toEqual({ closed: true, all: true });
    expect(() => parseArgs(['scan', '--bogus'])).toThrow('unknown option --bogus');
    expect(() => parseArgs(['scan', '--candidates', '2'])).toThrow('unknown option --candidates');
    expect(() => parseArgs(['fix', '--model'])).toThrow('--model requires a value');
  });

  it('has three commands and prints their usage', async () => {
    const { out, err, io } = capture();
    expect(await main(['--help'], io)).toBe(0);
    for (const verb of ['scan [target]', 'findings [finding-id]', 'fix [finding-id | path]']) expect(out[0]).toContain(verb);
    for (const gone of ['hunt', 'refactor', 'report', 'publish', 'design']) expect(out[0]).not.toMatch(new RegExp(`^\\s*${gone} `, 'm'));
    expect(await main(['fix', '-h'], io)).toBe(0);
    expect(out.at(-1)).toContain('perch fix: Fix open issues, one commit each');
    expect(out.at(-1)).toContain('--budget');
    expect(await main(['scan', '-h'], io)).toBe(0);
    expect(out.at(-1)).toContain('perch scan: Find issues');
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
    expect(out.at(-1)).toBe('Nothing matches.');
  });

  it('prints the table and nothing else, ten rows unless --all', async () => {
    const repoRoot = await makeGraphFixture();
    cleanups.push(repoRoot);
    const repo = { root: repoRoot, revision: await revision(repoRoot), out: join(repoRoot, '.perch') };
    await scanRepository(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), systemOne: scriptedSystemOne({}), budget: 4 }));
    const { out, io } = capture();
    expect(await main(['findings', '--out', repo.out, '--min', '0'], io)).toBe(0);
    const rows = out.at(-1).split('\n');
    // No count, no hint, no footer: the header and the rows.
    expect(rows[0]).toMatch(/^ID +Method/);
    expect(rows.every(row => /^(ID|[0-9a-f]{8}) /.test(row))).toBe(true);
    expect(rows.length - 1).toBeLessThanOrEqual(10);
  });

  it('answers a bad filter with the real values, under the old command name too, without crashing', async () => {
    const { out, err, io } = capture();
    // `issues` is the older name for `findings`; a usage error on it must reach that command's help, not an undefined one.
    expect(await main(['issues', '--filter', 'status=p1'], io)).toBe(2);
    expect(err.at(-1)).toContain('unknown filter "status"; filter on type, kind, severity');
    expect(err.at(-1)).toContain('perch findings:');
    expect(await main(['issues', '--filter', 'severity=p9'], io)).toBe(2);
    expect(err.at(-1)).toContain('severity "p9" is not one of P0, P1, P2, P3');
    expect(await main(['findings', '--filter', 'kind=nope'], io)).toBe(2);
    expect(err.at(-1)).toContain('too big');
    expect(await main(['issues', '-h'], io)).toBe(0);
    expect(out.at(-1)).toContain('perch findings: List what the scan found');
    expect(await main(['findings', '--types'], io)).toBe(0);
    expect(out.at(-1)).toContain('severity\n  P0\n  P1\n  P2\n  P3');
  });

  it('lists the issues a scan found, from the results directory', async () => {
    const repoRoot = await makeGraphFixture();
    cleanups.push(repoRoot);
    const repo = { root: repoRoot, revision: await revision(repoRoot), out: join(repoRoot, '.perch') };
    const hunt = await scanRepository(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), systemOne: scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.8, kind_wrong_return: 0.6, severe_recoverable: 0.8 } }), budget: 2 }));
    const { out, err, io } = capture();
    const [f] = hunt.visited;
    expect(await main(['issues', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toMatch(new RegExp(`^${f.id}  f +src/a.js:\\d+ +wrong return value 80% +P2 +open +-`, 'm'));
    expect(out.at(-1)).toMatch(/^ID +Method +Location +Issues +Severity +Status +Commit$/m);
    // A filter that matches keeps the row; one that does not leaves nothing.
    expect(await main(['findings', '--filter', 'type=defect,severity=P2', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toContain(f.id);
    expect(await main(['findings', '--filter', 'type=security', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toBe('Nothing matches.');
    expect(out.at(-1)).not.toContain('Work');
    const code = await main(['issues', f.id.slice(0, 5), '--out', repo.out, '--verbose'], io);
    if (code !== 0) throw new Error(err.join('\n'));
    expect(out.at(-1)).toContain('Defect: 80%');
    expect(out.at(-1)).toContain('wrong return value 60%');
    expect(out.at(-1)).toContain('Metrics: risk');
    expect(await main(['issues', '--out', repo.out, '--min', '90'], io)).toBe(0);
    expect(out.at(-1)).toBe('Nothing matches.');
    expect(await main(['issues', '--out', repo.out, '--json'], io)).toBe(0);
    expect(JSON.parse(out.at(-1))[0].id).toBe(f.id);
  });

  it('bundles with esbuild into a loadable module', async () => {
    await promisify(execFile)('node', ['build.mjs'], { cwd: root });
    const bundle = await import(new URL('../dist/cli.mjs', import.meta.url).href);
    expect(typeof bundle.main).toBe('function');
  }, 60_000);
});
