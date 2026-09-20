import { execFile } from 'node:child_process';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs, VERSION } from '../src/cli.js';
import { parseFilters } from '../src/questions.js';
import { parseQuestions, questionSet, questionsFor } from '../src/ask.js';
import { readLint } from '../src/units.js';
import { gating, shownIssues } from '../src/report.js';
import { revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { scanRepository } from '../src/scan.js';
import { openStore } from '../src/store.js';
import { formatFinding, formatIssues, formatScanReport, scanTally } from '../src/report.js';
import { commitAll, fixtureOptions, makeFixture, makeGraphFixture, scriptedSystemOne } from './helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cleanups = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

function capture() {
  const out = [], err = [];
  return { out, err, io: { stdout: text => out.push(text), stderr: text => err.push(text), env: {} } };
}

describe('cli', () => {
  it('parses flags and positionals', () => {
    expect(parseArgs(['scan', 'owner/repo', '--paths', 'src,lib', '--parallel', '3', '--json'])).toEqual({
      flags: { paths: 'src,lib', parallel: '3', json: true }, positional: ['scan', 'owner/repo'] });
    expect(parseArgs(['lint', 'add', 'no-stale', '--ensure_absent', 'a doc for something deleted', '--where', 'docs/**'])).toEqual({ flags: { ensure_absent: 'a doc for something deleted', where: 'docs/**' }, positional: ['lint', 'add', 'no-stale'] });
    expect(parseArgs(['issues', '--closed', '--all']).flags).toEqual({ closed: true, all: true });
    expect(() => parseArgs(['scan', '--bogus'])).toThrow('unknown option --bogus');
    expect(() => parseArgs(['scan', '--candidates', '2'])).toThrow('unknown option --candidates');
    expect(() => parseArgs(['lint', 'add', 'x', '--ensure'])).toThrow('--ensure requires a value');
  });

  it('lists its commands and prints their usage', async () => {
    const { out, err, io } = capture();
    expect(await main(['--help'], io)).toBe(0);
    for (const verb of ['scan [target]', 'rules [list', 'issues [issue-id]', 'check <path', 'doctor']) expect(out[0]).toContain(verb);
    for (const name of ['PERCH_API_KEY', 'PERCH_BASE_URL', 'PERCH_MODEL_ID']) expect(out[0]).toContain(name);
    for (const gone of ['hunt', 'lint', 'refactor', 'report', 'publish', 'design', 'fix']) expect(out[0]).not.toMatch(new RegExp(`^\\s*${gone} `, 'm'));
    expect(await main(['check', '-h'], io)).toBe(0);
    expect(out.at(-1)).toContain('perch check: Ask about one piece of code, uncommitted');
    expect(out.at(-1)).toContain('--rules');
    expect(out.at(-1)).toContain('PERCH_BASE_URL');
    expect(await main(['scan', '-h'], io)).toBe(0);
    expect(out.at(-1)).toContain('perch scan: Find issues');
    expect(out.at(-1)).toContain('PERCH_BASE_URL');
    for (const gone of ['hunt', 'lint', 'refactor', 'report', 'fix']) expect(await main([gone], io)).toBe(2);
    expect(await main(['issues', '--limit', '0'], io)).toBe(2);
    expect(err.join('\n')).toContain('--limit must be a positive integer');
    expect(await main(['check'], io)).toBe(2);
    expect(err.join('\n')).toContain('perch check needs a path, a path::method, or an issue id');
  });

  it('refuses a flag the command does not take, and names the command that does', async () => {
    const { err, io } = capture();
    expect(await main(['scan', '--closed'], io)).toBe(2);
    expect(err.join('\n')).toContain('perch scan does not take --closed; it belongs to issues');
    expect(err.join('\n')).toContain('perch scan --help');
    expect(await main(['scan', '--rules', 'a'], io)).toBe(2);
    expect(err.join('\n')).toContain('perch scan does not take --rules; it belongs to check');
    // An alias is checked against the command it resolves to, and a flag both commands take is fine.
    expect(await main(['findings', '--parallel', '2'], io)).toBe(2);
    expect(err.join('\n')).toContain('perch issues does not take --parallel; it belongs to scan');
  });

  it('reports a defect whose line was never located, rather than throwing on it', () => {
    // A defect points at a line inside the method, and three places read that line while a fourth guarded it. Every reading a
    // scan writes has one, so nothing reached them; a reading carried from a version that did not write one would have.
    const finding = { id: 'abc12345', path: 'src/x.js', name: 'f', line: 7, end_line: 9, method: 'src/x.js::f',
      has_bug: 0.9, kind: { choice: 'boundary', probability: 0.9, probabilities: { boundary: 0.9 } },
      severity: { probabilities: { 1: 1 }, score: 1, confidence: 0.8, level: 'P1', predicted: 1 }, metrics: {}, file: {} };
    // It falls back to the method's own line, which is the honest answer when no line inside it was chosen.
    expect(formatIssues([finding], 0.5, 10, {})).toContain('src/x.js:7');
    expect(formatScanReport([finding], { color: false })).toContain('src/x.js');
    // And the line it points at is left out of the finding rather than printed as undefined.
    const opened = formatFinding(finding, { color: false });
    expect(opened).not.toContain('the line it points at');
    expect(opened).toContain('off_by_one');
  });

  it('does not call a run clean when a filter is what emptied it', () => {
    // A refactor finding, and a filter asking for defects. The repository has something to report; this filter passed over it.
    // Saying "nothing to report" after reading every method is the report describing the filter as the repository.
    const finding = { id: 'abc12345', path: 'src/x.js', name: 'f', line: 7, end_line: 9, method: 'src/x.js::f',
      refactor: { choice: 'too_big', probability: 0.9, probabilities: { too_big: 0.9 } }, metrics: {}, file: {} };
    const tally = scanTally([finding], 0.5, false, [{ key: 'type', value: 'defect' }]);
    expect(tally).toContain('nothing matching type=defect');
    expect(tally).toContain('1 problem');
    // With no filter, and with nothing found at all, the plain line is still the right one.
    expect(scanTally([finding], 0.5, false, [])).toContain('1 problem');
    expect(scanTally([], 0.5, false, [{ key: 'type', value: 'defect' }])).toBe('\u2713 nothing to report');
  });

  it('says what is running, before it cares which command you typed', async () => {
    const { out, io } = capture();
    // Asked of perch itself, so it is answered whatever follows it, and by a command that does not exist either.
    for (const argv of [['--version'], ['-v'], ['scan', '--version'], ['nonsense', '-v']]) {
      expect(await main(argv, io)).toBe(0);
      expect(out.at(-1)).toBe(VERSION);
    }
    // A working copy is not the release whose number is in package.json, and says so rather than claiming to be it.
    expect(VERSION === 'dev' || /^\d+\.\d+\.\d+$/.test(VERSION) || VERSION.startsWith('DEVELOPMENT')).toBe(true);
  });

  it('needs a perch API key to ask anything, but none to read what it already knows', async () => {
    const repo = await makeFixture();
    cleanups.push(repo);
    const { out, err, io } = capture();
    expect(await main(['scan', repo], io)).toBe(1);
    expect(err.join('\n')).toContain('PERCH_API_KEY');
    expect(await main(['issues', '--out', join(repo, '.perch')], io)).toBe(0);
    expect(out.at(-1)).toBe('Nothing matches.');
  });

  it.each(['scan', 'check'])('%s uses the configured key, exact endpoint and model', async command => {
    const repo = await realpath(await makeFixture());
    cleanups.push(repo);
    await writeFile(join(repo, 'perch.yaml'), 'rules:\n  - name: endpoint-rule\n    where: src/clamp.js\n    ensure: The function returns a number.\n');
    await commitAll(repo, 'add file rule');
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    const service = scriptedSystemOne({ project: { 'endpoint-rule': 0.99 } });
    const requests = [];
    vi.stubGlobal('fetch', async (url, init) => {
      requests.push({ url, init });
      const { state, questions } = JSON.parse(init.body);
      return new Response(JSON.stringify(await service.ask(state, questions)));
    });
    const configurations = [
      { PERCH_API_KEY: 'default-key' },
      { PERCH_API_KEY: 'proxy-key', PERCH_BASE_URL: 'http://localhost:8123/infer', PERCH_MODEL_ID: 'custom-model' },
      { PERCH_API_KEY: 'gateway-key', PERCH_BASE_URL: 'http://localhost:8123/infer/', PERCH_MODEL_ID: 'another-model' },
      { PERCH_API_KEY: 'versioned-key', PERCH_BASE_URL: 'http://localhost:8123/infer?version=2', PERCH_MODEL_ID: 'model/v2' },
    ];
    for (const [index, env] of configurations.entries()) {
      const { out, err, io } = capture();
      io.env = env;
      const args = command === 'scan'
        ? ['scan', repo, '--filter', 'rule=endpoint-rule']
        : ['check', 'src/clamp.js', '--rules', 'endpoint-rule'];
      requests.length = 0;
      const code = await main([...args, '--json', '--out', join(repo, `.perch-${index}`)], io);
      expect(code, err.join('\n')).toBe(0);
      expect(out.length).toBeGreaterThan(0);
      expect(requests.length).toBeGreaterThan(0);
      for (const { url, init } of requests) {
        expect(url).toBe(env.PERCH_BASE_URL ?? 'https://api.typesafe.ai/v1/systemone');
        expect(init.headers.authorization).toBe(`Bearer ${env.PERCH_API_KEY}`);
        expect(JSON.parse(init.body)).toMatchObject({ model: env.PERCH_MODEL_ID ?? 'jev-latest', questions: { 'endpoint-rule': { type: 'noul' } } });
      }
    }
  });

  it('doctor recognizes PERCH_API_KEY without printing its value', async () => {
    const repo = await realpath(await makeFixture());
    cleanups.push(repo);
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    const { out, io } = capture();
    io.env = { PERCH_API_KEY: 'private-fixture-key' };
    expect(await main(['doctor', '--json', '--out', join(repo, '.perch')], io)).toBe(0);
    expect(JSON.parse(out.at(-1)).checks).toContainEqual({ name: 'key', ok: true, found: 'PERCH_API_KEY, 19 characters' });
    expect(out.join('\n')).not.toContain(io.env.PERCH_API_KEY);
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
    // Filtered on something the fixture carries, or the comparison below is two empty lists agreeing.
    expect(await main(['issues', '--out', repo.out, '--filter', 'type=docs'], io)).toBe(0);
    const filtered = count(out.at(-1));
    expect(await main(['issues', '--out', repo.out, '--all'], io)).toBe(0);
    // A filter names what you want, so it is not cut down: it prints what --all would, minus what the filter dropped.
    expect(filtered).toBe(count(out.at(-1)));
  });

  it('answers a bad filter with the real values, under the old command name too, without crashing', async () => {
    const { out, err, io } = capture();
    // `findings` is another name for `issues`; a usage error on it must reach that command's help, not an undefined one.
    expect(await main(['issues', '--filter', 'status=p1'], io)).toBe(2);
    expect(err.join('\n')).toContain('unknown filter "status"; filter on type, kind, severity');
    expect(err.join('\n')).toContain('perch issues --help');
    expect(await main(['issues', '--filter', 'severity=p9'], io)).toBe(2);
    expect(err.join('\n')).toContain('severity "p9" is not one of P3, P2, P1, P0');
    expect(await main(['findings', '--filter', 'kind=nope'], io)).toBe(2);
    expect(err.join('\n')).toContain('too_big');
    expect(await main(['findings', '-h'], io)).toBe(0);
    expect(out.at(-1)).toContain('perch issues: List what the scan found');
    expect(await main(['findings', '--types'], io)).toBe(0);
    expect(out.at(-1)).toContain('severity\n  P3\n  P2\n  P1\n  P0');
    // A filter clause that names nothing is a mistake to correct, whichever command reads it.
    expect(await main(['issues', '--filter', 'issue=p1'], io)).toBe(2);
    expect(err.join('\n')).toContain('unknown filter "issue"; filter on type, kind, severity');
    // A defect is a bug, and typing the word everyone uses is not a mistake. The listing says so rather than leaving you to
    // find out by being wrong, and a word that means nothing is still wrong.
    expect(await main(['issues', '--types'], io)).toBe(0);
    expect(out.at(-1)).toContain('defect (or bug)');
    expect(parseFilters('type=bug')).toEqual([{ key: 'type', value: 'defect' }]);
    expect(parseFilters('type=BUG')).toEqual([{ key: 'type', value: 'defect' }]);
    expect(() => parseFilters('type=bugz')).toThrow('is not one of');
  });

  it('reports a broken search rule and fails the run on it', () => {
    // An ensure_present rule is answered over the repository rather than per file, so its result arrives as a finding of its own
    // under a `search:` unit. The scan used to drop exactly those: the table, the tally and the exit code all read shownIssues,
    // so a rule broken at 100% printed nothing and exited 0 while `perch issues` listed it.
    const rule = parseQuestions('- name: demo-rule\n  where: "src/**/*.js"\n  ensure_present: A thing that is not here.\n', 'fixture', 'rule');
    const questions = [...questionSet(), ...rule];
    const finding = { id: 'aaaa1111', unit: 'search:demo-rule', path: 'perch.yaml', name: 'src/**/*.js', line: 1,
      lint: { rule: 'demo-rule', broken: 1, text: 'demo-rule 100%', said: 'A thing that is not here.' } };

    expect(shownIssues(finding, 0)).toHaveLength(1);
    // Under its own header, since it is not about a file and a file header would read like perch went through your rules.
    const report = formatScanReport([finding], { color: false, summary: false });
    expect(report).toContain('searched the repository');
    expect(report).toContain('demo-rule');
    // And it gates, which is the exit code. A rule declaring no issue of its own defaulted to never failing, and every search
    // rule declares none.
    expect(rule[0].gate).toBe(true);
    expect(gating([finding], 0, questions)).toHaveLength(1);
  });

  it('takes several values for one key, and names a rule as one of them', () => {
    // A part with no `=` belongs to the key before it. Without this, type=defect,security read `security` as a key and the form
    // the docs showed was an error.
    expect(parseFilters('type=defect,security')).toEqual([{ key: 'type', value: 'defect' }, { key: 'type', value: 'security' }]);
    expect(parseFilters('type=defect,kind=too_big')).toEqual([{ key: 'type', value: 'defect' }, { key: 'kind', value: 'too big' }]);
    expect(() => parseFilters('defect')).toThrow(/written key=value/);

    // A rule is filterable by name, so a rule just written can be run on its own rather than behind every other rule.
    const rules = [{ name: 'fixture-rule-one' }, { name: 'fixture-rule-two' }];
    expect(parseFilters('rule=fixture-rule-one,fixture-rule-two', rules)).toEqual([
      { key: 'rule', value: 'fixture rule one' }, { key: 'rule', value: 'fixture rule two' },
    ]);
    // The names come from the repository, so a filter with none to offer says that rather than listing nothing.
    expect(() => parseFilters('rule=fixture-rule-one')).toThrow(/there are none/);
    expect(() => parseFilters('rule=nope', rules)).toThrow('is not one of');
  });

  it('asks only the rule a filter named', () => {
    // Names this repository does not use, since perch.yaml's own rules are compiled into the question set by then.
    const rules = [
      { name: 'fixture-rule-one', each: 'method', issue: { type: 'lint', label: 'self' }, kind: 'ensure' },
      { name: 'fixture-rule-two', each: 'method', issue: { type: 'lint', label: 'self' }, kind: 'ensure' },
    ];
    const asked = questionsFor([...questionSet(), ...rules], parseFilters('rule=fixture-rule-one', rules), kind => kind);
    // The one rule, and nothing else: no has_bug, no security classes, no other rule.
    expect(asked.map(question => question.name)).toEqual(['fixture-rule-one']);
  });

  it('does not call an ensure_present rule satisfied when nothing answered it', () => {
    // A scan decides a present rule over the whole codebase, so readLint reports it unbroken per unit: one file lacking the
    // thing is not the rule failing. perch check read that same field, so it was green for any present rule whatever the file
    // said, which reads as the rule passing rather than as nothing having been asked.
    const [rule] = parseQuestions('- name: demo-present\n  where: "src/**/*.js"\n  ensure_present: A thing that is not here.\n', 'fixture', 'rule');
    expect(readLint(rule, { 'demo-present': { noul: 0.02 } })).toMatchObject({ here: 0.02, broken: 0 });
    // The check path asks about the unit you named, so not here is what it reports.
    expect(1 - readLint(rule, { 'demo-present': { noul: 0.02 } }).here).toBeCloseTo(0.98);
    expect(1 - readLint(rule, { 'demo-present': { noul: 0.9 } }).here).toBeCloseTo(0.1);
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
    // One issue opened up reads in the columns a run prints, with what was asked under it.
    expect(out.at(-1)).toMatch(/^ {2}Confidence {2}Type +Severity +Problem$/m);
    expect(out.at(-1)).toMatch(/^ +80% {2}defect {2}P\d \(\d\.\d\) {2}wrong_return_value$/m);
    expect(out.at(-1)).toMatch(/^ {2}Kind +wrong_return_value \d+%/m);
    expect(out.at(-1)).toMatch(/^ {2}Code +risk \d+ {2}maintainability \d+/m);
    // The line it points at, with the code on it.
    expect(out.at(-1)).toMatch(/^ +\d+ {2}\S/m);
    expect(out.at(-1)).toMatch(/the line it points at, \d+% sure/);
    // --min is how sure the scan has to be: nothing is answered at a flat 100%, and over 100 is not a percentage.
    expect(await main(['issues', '--out', repo.out, '--min', '100'], io)).toBe(0);
    expect(out.at(-1)).toBe('Nothing matches.');
    expect(await main(['issues', '--out', repo.out, '--min', '900'], io)).toBe(2);
    expect(err.join('\n')).toContain('--min must be a percentage, 0 to 100');
    expect(await main(['issues', '--out', repo.out, '--json'], io)).toBe(0);
    expect(JSON.parse(out.at(-1))[0].id).toBe(f.id);
  });

  it('ranks a filtered list by the problem that was filtered for', async () => {
    const repoRoot = await makeGraphFixture();
    cleanups.push(repoRoot);
    const repo = { root: repoRoot, revision: await revision(repoRoot), out: join(repoRoot, '.perch') };
    // f is the heavier method overall; h is the one that is probably injectable.
    const hunt = await scanRepository(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), systemOne: scriptedSystemOne({
      'src/a.js::f': { has_bug: 0.9, exposed: 0.9, injection: 0.1 },
      'src/b.js::h': { has_bug: 0.1, exposed: 0.9, injection: 0.95 },
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
    expect(err.join('\n')).toContain('--limit must be a positive integer');
  });

  it('closes an issue, keeps why, and keeps it closed across scans and edits', async () => {
    const repoRoot = await makeGraphFixture();
    cleanups.push(repoRoot);
    // A scan asks about defects, vulnerabilities and rules unless perch.yaml says otherwise, and this is about closing a docs
    // finding, so it has to ask for one.
    await writeFile(join(repoRoot, 'perch.yaml'), 'scan_types: [defect, security, lint, refactor, docs]\nrules: []\n');
    await commitAll(repoRoot, 'scan types');
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
    expect(out.at(-1)).toMatch(/^\S+ {2}f {2}src\/a\.js:\d/m);
    expect(out.at(-1)).toContain('closed');
    // What was closed and why, since a closure covers the kinds it was made about and not the method entire.
    expect(out.at(-1)).toMatch(/^ {2}Closed {2}.*verifies before it parses$/m);

    // A closure is a decision, and it holds until it is taken back: scanning again does not put it back on the list.
    await scanRepository(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), systemOne: scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.9 } }) }));
    expect(await main(['issues', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).not.toContain(f.id);

    // Nor does editing the method it was about. Perch was wrong, or you looked and left it, and moving a line says neither.
    await writeFile(join(repoRoot, 'src', 'a.js'), (await readFile(join(repoRoot, 'src', 'a.js'), 'utf8')).replace('x > 10', 'x > 11'));
    await commitAll(repoRoot, 'change f');
    await scanRepository(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), revision: await revision(repoRoot), systemOne: scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.9 } }) }));
    expect(await main(['issues', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).not.toContain(f.id);

    // perch reopen is how it comes back, and only that.
    expect(await main(['reopen', f.id, '--out', repo.out], io)).toBe(0);
    expect(await main(['issues', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toContain(f.id);

    // A closure is about the one thing closed. Every other method the scan read is still live.
    expect(await main(['close', f.id, '--out', repo.out], io)).toBe(0);
    expect(await main(['issues', '--all', '--out', repo.out], io)).toBe(0);
    const listed = out.at(-1).split('\n').filter(line => /^[0-9a-f]{8} {2}/.test(line));
    expect(listed.length).toBeGreaterThan(1);
    expect(listed.some(line => line.startsWith(f.id))).toBe(false);

    // And about what it was listing, not about every answer behind it. Closing a method for the one thing shown used to set
    // aside every class the reading holds at any probability, so a real one turning up later could never be listed.
    const closed = (await openStore(repo.out).indexes()).dismissals.get(f.id);
    expect([...closed.kinds].sort()).toEqual(['docs', 'inverted_condition']);

    expect(await main(['close', '--out', repo.out], io)).toBe(2);
    expect(err.join('\n')).toContain('perch close needs at least one issue id');
    expect(await main(['reopen', 'zzzz', '--out', repo.out], io)).toBe(1);
    expect(err.join('\n')).toContain('no finding zzzz');
  });


  it('closes one kind of an issue and leaves the rest of it live', async () => {
    const repoRoot = await makeGraphFixture();
    cleanups.push(repoRoot);
    // Closing one kind and leaving the rest needs more than one kind on the method, so the advisory types are asked for here.
    await writeFile(join(repoRoot, 'perch.yaml'), 'scan_types: [defect, security, lint, refactor, docs]\nrules: []\n');
    await commitAll(repoRoot, 'scan types');
    const repo = { root: repoRoot, revision: await revision(repoRoot), out: join(repoRoot, '.perch') };
    const answers = { 'src/a.js::f': { has_bug: 0.9, kind: 'wrong_return', documented: 0.2, severity: 2 } };
    const hunt = await scanRepository(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), systemOne: scriptedSystemOne(answers) }));
    const f = hunt.visited.find(visit => visit.method === 'src/a.js::f');
    const { out, err, io } = capture();
    const row = async () => { await main(['issues', '--out', repo.out], io); return out.at(-1).split('\n').find(line => line.startsWith(f.id)) ?? ''; };
    expect(await row()).toContain('wrong_return_value');
    expect(await row()).toContain('docs');

    // Closing the documentation says nothing about the defect, so the defect is still listed and the issue is still open.
    expect(await main(['close', f.id, '--kind', 'docs', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toContain('closed  docs');
    expect(await row()).toContain('wrong_return_value');
    expect(await row()).not.toContain('docs');

    // And it is only that kind that comes back.
    expect(await main(['reopen', f.id, '--kind', 'docs', '--out', repo.out], io)).toBe(0);
    expect(await row()).toContain('docs');

    // A kind nothing can be listed under closes nothing, which is a mistake to say so rather than a closure that does nothing.
    expect(await main(['close', f.id, '--kind', 'nonsense', '--out', repo.out], io)).toBe(2);
    expect(err.join('\n')).toContain('nonsense is not a kind');
  });

  it('closes what an issue carries now, so something found in it later is a new thing', async () => {
    const repoRoot = await makeGraphFixture();
    cleanups.push(repoRoot);
    // The docs finding is what this closes, so it has to be asked for.
    await writeFile(join(repoRoot, 'perch.yaml'), 'scan_types: [defect, security, lint, refactor, docs]\nrules: []\n');
    await commitAll(repoRoot, 'scan types');
    const repo = { root: repoRoot, revision: await revision(repoRoot), out: join(repoRoot, '.perch') };
    const quiet = { 'src/a.js::f': { has_bug: 0.1, documented: 0.2 } };
    const hunt = await scanRepository(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), systemOne: scriptedSystemOne(quiet) }));
    const f = hunt.visited.find(visit => visit.method === 'src/a.js::f');
    const { out, io } = capture();
    expect(await main(['close', f.id, '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).toContain('closed  docs');
    expect(await main(['issues', '--out', repo.out], io)).toBe(0);
    expect(out.at(-1)).not.toContain(f.id);

    // Closing a method for being undocumented is not a promise that nothing will ever be wrong with it. The method has to change
    // for anything new to be found in it, since a scan does not ask again about code nothing has touched.
    await writeFile(join(repoRoot, 'src', 'a.js'), (await readFile(join(repoRoot, 'src', 'a.js'), 'utf8')).replace('x > 10', 'x > 11'));
    await commitAll(repoRoot, 'change f');
    await scanRepository(fixtureOptions(repo, { analyzer: createSourceAnalyzer(), revision: await revision(repoRoot),
      systemOne: scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.9, kind: 'wrong_return', documented: 0.2, severity: 2 } }) }));
    expect(await main(['issues', '--out', repo.out], io)).toBe(0);
    const row = out.at(-1).split('\n').find(line => line.startsWith(f.id)) ?? '';
    expect(row).toContain('wrong_return_value');
    expect(row).not.toContain('docs');
  });

  it('bundles with esbuild into a loadable module', async () => {
    await promisify(execFile)('node', ['build.mjs'], { cwd: root });
    const bundle = await import(new URL('../dist/cli.mjs', import.meta.url).href);
    expect(typeof bundle.main).toBe('function');
  }, 60_000);
});
