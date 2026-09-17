import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { main, parseArgs } from '../src/cli.js';
import { revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { scanRepository } from '../src/hunt.js';
import { commitAll, fixtureOptions, makeFixture, makeGraphFixture, scriptedSystemOne } from './helpers.js';

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
    for (const verb of ['scan [target]', 'lint', 'issues [issue-id]', 'check <path', 'doctor']) expect(out[0]).toContain(verb);
    for (const gone of ['hunt', 'refactor', 'report', 'publish', 'design', 'fix']) expect(out[0]).not.toMatch(new RegExp(`^\\s*${gone} `, 'm'));
    expect(await main(['check', '-h'], io)).toBe(0);
    expect(out.at(-1)).toContain('perch check: Ask the rules about one piece of code');
    expect(out.at(-1)).toContain('--rules');
    expect(await main(['scan', '-h'], io)).toBe(0);
    expect(out.at(-1)).toContain('perch scan: Find issues');
    for (const gone of ['hunt', 'refactor', 'report', 'fix']) expect(await main([gone], io)).toBe(2);
    expect(await main(['issues', '--limit', '0'], io)).toBe(2);
    expect(err.at(-1)).toContain('--limit must be a positive integer');
    expect(await main(['check'], io)).toBe(2);
    expect(err.at(-1)).toContain('perch check needs a path, a path::method, or an issue id');
  });

  it('refuses a flag the command does not take, and names the command that does', async () => {
    const { err, io } = capture();
    expect(await main(['scan', '--filter', 'type=security'], io)).toBe(2);
    expect(err.at(-1)).toContain('perch scan does not take --filter; it belongs to issues');
    expect(err.at(-1)).toContain('perch scan: Find issues');
    expect(await main(['scan', '--rules', 'a'], io)).toBe(2);
    expect(err.at(-1)).toContain('perch scan does not take --rules; it belongs to check');
    // An alias is checked against the command it resolves to, and a flag both commands take is fine.
    expect(await main(['findings', '--force'], io)).toBe(2);
    expect(err.at(-1)).toContain('perch issues does not take --force; it belongs to scan');
  });

  it('needs a TypeSafe key to ask anything, but none to read what it already knows', async () => {
    const repo = await makeFixture();
    cleanups.push(repo);
    const { out, err, io } = capture();
    expect(await main(['scan', repo], io)).toBe(1);
    expect(err.at(-1)).toContain('TYPESAFE_API_KEY');
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

  it('cuts an unasked-for list to ten rows and a filtered one to none', async () => {
    const repoRoot = await makeGraphFixture();
    cleanups.push(repoRoot);
    const repo = { root: repoRoot, revision: await revision(repoRoot), out: join(repoRoot, '.perch') };
    await scanRepository(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), systemOne: scriptedSystemOne({}) }));
    const { out, io } = capture();
    const count = text => text.split('\n').length - 1;
    expect(await main(['issues', '--out', repo.out, '--filter', 'type=defect'], io)).toBe(0);
    const filtered = count(out.at(-1));
    expect(await main(['issues', '--out', repo.out, '--all'], io)).toBe(0);
    // A filter names what you want, so it is not cut down: it prints what --all would, minus what the filter dropped.
    expect(filtered).toBe(count(out.at(-1)));
  });

  it('answers a bad filter with the real values, under the old command name too, without crashing', async () => {
    const { out, err, io } = capture();
    // `findings` is another name for `issues`; a usage error on it must reach that command's help, not an undefined one.
    expect(await main(['issues', '--filter', 'status=p1'], io)).toBe(2);
    expect(err.at(-1)).toContain('unknown filter "status"; filter on type, kind, severity');
    expect(err.at(-1)).toContain('perch issues:');
    expect(await main(['issues', '--filter', 'severity=p9'], io)).toBe(2);
    expect(err.at(-1)).toContain('severity "p9" is not one of P3, P2, P1, P0');
    expect(await main(['findings', '--filter', 'kind=nope'], io)).toBe(2);
    expect(err.at(-1)).toContain('too_big');
    expect(await main(['findings', '-h'], io)).toBe(0);
    expect(out.at(-1)).toContain('perch issues: List what the scan found');
    expect(await main(['findings', '--types'], io)).toBe(0);
    expect(out.at(-1)).toContain('severity\n  P3\n  P2\n  P1\n  P0');
    // A filter clause that names nothing is a mistake to correct, whichever command reads it.
    expect(await main(['issues', '--filter', 'issue=p1'], io)).toBe(2);
    expect(err.at(-1)).toContain('unknown filter "issue"; filter on type, kind, severity');
  });

  it('lists the issues a scan found, from the results directory', async () => {
    const repoRoot = await makeGraphFixture();
    cleanups.push(repoRoot);
    const repo = { root: repoRoot, revision: await revision(repoRoot), out: join(repoRoot, '.perch') };
    const hunt = await scanRepository(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), systemOne: scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.8, kind: 'wrong_return', severity: 1 } }), budget: 2 }));
    const { out, err, io } = capture();
    const [f] = hunt.visited;
    expect(await main(['issues', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toMatch(new RegExp(`^${f.id}  f +src/a.js:\\d+ +defect +wrong_return_value \\d+%.* +P2 \\(1\\.8\\)$`, 'm'));
    // Every column a filter reads is named after it: kind, severity.
    // Status and Commit are not columns: an open list is all open, and the commit is in `perch issues <id>` and in git log.
    expect(out.at(-1)).toMatch(/^ID +Method +Location +Type +Kind +Severity$/m);
    // A filter that matches keeps the row; one that does not leaves nothing.
    expect(await main(['findings', '--filter', 'type=defect,severity=P2', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toContain(f.id);
    expect(await main(['findings', '--filter', 'kind=injection', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toBe('Nothing matches.');
    expect(out.at(-1)).not.toContain('Work');
    const code = await main(['issues', f.id.slice(0, 5), '--out', repo.out, '--verbose'], io);
    if (code !== 0) throw new Error(err.join('\n'));
    expect(out.at(-1)).toContain('Defect: 80%');
    expect(out.at(-1)).toContain('wrong_return_value');
    expect(out.at(-1)).toContain('Metrics: risk');
    // --min is how sure the scan has to be: nothing is answered at a flat 100%, and over 100 is not a percentage.
    expect(await main(['issues', '--out', repo.out, '--min', '100'], io)).toBe(0);
    expect(out.at(-1)).toBe('Nothing matches.');
    expect(await main(['issues', '--out', repo.out, '--min', '900'], io)).toBe(2);
    expect(err.at(-1)).toContain('--min must be a percentage, 0 to 100');
    expect(await main(['issues', '--out', repo.out, '--json'], io)).toBe(0);
    expect(JSON.parse(out.at(-1))[0].id).toBe(f.id);
  });

  it('ranks a filtered list by the problem that was filtered for', async () => {
    const repoRoot = await makeGraphFixture();
    cleanups.push(repoRoot);
    const repo = { root: repoRoot, revision: await revision(repoRoot), out: join(repoRoot, '.perch') };
    // f is the heavier method overall; h is the one that is probably injectable.
    const hunt = await scanRepository(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), systemOne: scriptedSystemOne({
      'src/a.js::f': { has_bug: 0.9, exposed: 0.9, security_injection: 0.1 },
      'src/b.js::h': { has_bug: 0.1, exposed: 0.9, security_injection: 0.95 },
    }) }));
    const f = hunt.visited.find(visit => visit.method === 'src/a.js::f').id;
    const h = hunt.visited.find(visit => visit.method === 'src/b.js::h').id;
    const { out, io } = capture();
    const idsOf = text => text.split('\n').slice(1).map(row => row.slice(0, 8));

    expect(await main(['findings', '--out', repo.out], io)).toBe(0);
    expect(idsOf(out.at(-1))[0]).toBe(f);
    // Filtering for injection puts the likeliest injection first, not the method carrying the most of everything else.
    expect(await main(['issues', '--filter', 'kind=injection', '--out', repo.out], io)).toBe(0);
    expect(idsOf(out.at(-1))[0]).toBe(h);
    // Filtering on what f leads with puts f back on top.
    expect(await main(['issues', '--filter', 'type=defect', '--out', repo.out], io)).toBe(0);
    expect(idsOf(out.at(-1))[0]).toBe(f);

    // A filtered row leads with what was filtered for: f's loudest problem is not security, but under a security filter its row
    // must say security, or it contradicts the filter that selected it.
    expect(await main(['issues', '--out', repo.out], io)).toBe(0);
    const unfiltered = out.at(-1).split('\n').find(row => row.startsWith(f));
    expect(unfiltered).not.toMatch(/^\S+ +\S+ +\S+ +security /);
    expect(await main(['issues', '--filter', 'type=security', '--out', repo.out], io)).toBe(0);
    for (const row of out.at(-1).split('\n').slice(1)) expect(row).toMatch(/^\S+ +\S+ +\S+ +security /);
  });

  it('pages through the list and says where you are', async () => {
    const repoRoot = await makeGraphFixture();
    cleanups.push(repoRoot);
    const repo = { root: repoRoot, revision: await revision(repoRoot), out: join(repoRoot, '.perch') };
    await scanRepository(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), systemOne: scriptedSystemOne({}), budget: 4 }));
    const { out, err, io } = capture();
    const ids = text => text.split('\n').slice(1).map(row => row.slice(0, 8));

    expect(await main(['issues', '--out', repo.out, '--min', '0', '--limit', '2'], io)).toBe(0);
    const first = ids(out.at(-1));
    expect(first).toHaveLength(2);
    expect(err.at(-1)).toMatch(/^1-2 of \d+ open issues\. --page 2 for the next$/);

    expect(await main(['issues', '--out', repo.out, '--min', '0', '--limit', '2', '--page', '2'], io)).toBe(0);
    // A page is the next slice, not a repeat of the first.
    expect(ids(out.at(-1)).some(id => first.includes(id))).toBe(false);
    expect(err.at(-1)).toMatch(/^3-4 of \d+ open issues/);

    expect(await main(['issues', '--out', repo.out, '--min', '0', '--page', '99'], io)).toBe(0);
    expect(err.at(-1)).toMatch(/^page 99 is past the end\. \d+ open issues, \d+ pages?$/);
    expect(await main(['issues', '--out', repo.out, '--limit', '0'], io)).toBe(2);
    expect(err.at(-1)).toContain('--limit must be a positive integer');
  });

  it('closes an issue, keeps why, and brings it back when the method changes', async () => {
    const repoRoot = await makeGraphFixture();
    cleanups.push(repoRoot);
    const repo = { root: repoRoot, revision: await revision(repoRoot), out: join(repoRoot, '.perch') };
    const hunt = await scanRepository(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), systemOne: scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.9 } }) }));
    const [f] = hunt.visited;
    const { out, err, io } = capture();

    expect(await main(['close', f.id.slice(0, 5), '--reason', 'verifies before it parses', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toContain(`${f.id}  f  src/a.js:`);
    // Closed means gone from the list and skipped by fix; --closed shows it with why.
    expect(await main(['issues', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).not.toContain(f.id);
    expect(await main(['issues', '--closed', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toMatch(new RegExp(`^${f.id}.* dismissed$`, 'm'));
    expect(await main(['issues', f.id, '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toContain('Status: closed');
    expect(out.at(-1)).toContain('verifies before it parses');

    // Editing the method is a new judgement to make, so the dismissal lapses.
    await writeFile(join(repoRoot, 'src', 'a.js'), (await readFile(join(repoRoot, 'src', 'a.js'), 'utf8')).replace('x > 10', 'x > 11'));
    await commitAll(repoRoot, 'change f');
    await scanRepository(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), revision: await revision(repoRoot), systemOne: scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.9 } }) }));
    expect(await main(['issues', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toContain(f.id);

    expect(await main(['close', '--out', repo.out], io)).toBe(2);
    expect(err.at(-1)).toContain('perch close needs at least one issue id');
    expect(await main(['reopen', 'zzzz', '--out', repo.out], io)).toBe(1);
    expect(err.at(-1)).toContain('no finding zzzz');
  });

  it('bundles with esbuild into a loadable module', async () => {
    await promisify(execFile)('node', ['build.mjs'], { cwd: root });
    const bundle = await import(new URL('../dist/cli.mjs', import.meta.url).href);
    expect(typeof bundle.main).toBe('function');
  }, 60_000);
});
