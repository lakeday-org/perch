import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { mergeAnswers, scanRepository, typesAsked } from '../src/scan.js';
import { parseScanTypes, questionSet } from '../src/ask.js';
import { securityOf } from '../src/questions.js';
import { methodStep, methodSteps, issueWeight, locateWhere, MAX_CHOICES, STATE_BUDGET } from '../src/questions.js';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { openStore } from '../src/store.js';
import { createSystemOne } from '../src/systemone.js';
import { formatDoctor, formatScanReport, gating, scanCount } from '../src/report.js';
import { commitAll, fixtureOptions, makeGraphFixture, scriptedSystemOne } from './helpers.js';

const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture({ scanTypes } = {}) {
  const root = await makeGraphFixture();
  cleanups.push(root);
  // A scan asks about defects, vulnerabilities and rules unless perch.yaml says otherwise. A test about how a refactor row
  // renders, or about what it does to the exit code, has to ask for refactor answers to have any.
  if (scanTypes) {
    await writeFile(join(root, 'perch.yaml'), `scan_types: [${scanTypes.join(', ')}]\nrules: []\n`);
    await commitAll(root, 'scan types');
  }
  return { root, revision: await revision(root), out: join(root, '.perch') };
}

/** Hunt options that re-read HEAD, since a test may commit between hunts. */
const withRevision = async (repo, extra) => fixtureOptions(repo, { analyzer, revision: await revision(repo.root), ...extra });

describe('keeping results out of git status', () => {
  it('writes a .gitignore in the results directory, and leaves .git alone', async () => {
    const repo = await fixture();
    const store = openStore(repo.out);
    await store.exclude(repo.root);

    const written = await readFile(join(repo.out, '.gitignore'), 'utf8');
    expect(written).toContain('*');
    expect(written).toContain('!closed.jsonl');
    expect(existsSync(join(repo.root, '.git', 'info', 'exclude'))
      && (await readFile(join(repo.root, '.git', 'info', 'exclude'), 'utf8')).includes('.perch')).toBe(false);

    await writeFile(join(repo.out, 'scan.jsonl'), '{}\n');
    await writeFile(join(repo.out, 'closed.jsonl'), '{}\n');
    const untracked = await git(['status', '--porcelain', '--untracked-files=all'], repo.root);
    expect(untracked).toContain('.perch/closed.jsonl');
    expect(untracked).not.toContain('scan.jsonl');
    expect(untracked).not.toContain('.gitignore');
  });

  it('writes nothing when the results live outside the repository', async () => {
    const repo = await fixture();
    const outside = join(repo.root, '..', `perch-out-${Date.now()}`);
    const store = openStore(outside);
    await store.exclude(repo.root);
    expect(existsSync(join(outside, '.gitignore'))).toBe(false);
  });
});

describe('which issue types a scan asks about', () => {
  it('asks the three that can fail a run, and nothing else, unless perch.yaml says so', () => {
    // Refactor and docs never fail anything and read the same on every method that has ever been long. A scan of this
    // repository reported 32 of them against 0 defects, so the list a person opened was mostly rows they came for nothing.
    expect([...typesAsked(null, [])].sort()).toEqual(['defect', 'lint', 'security']);
    expect([...typesAsked(['defect', 'security', 'lint', 'refactor'], [])]).toContain('refactor');
    // Naming only some of them is naming them: this is the whole list, not an addition to the defaults.
    expect([...typesAsked(['docs'], [])]).toEqual(['docs']);
  });

  it('asks for a type a filter named, whatever perch.yaml left out', () => {
    // Narrowing a report to a type whose questions were never asked would report that the repository has none of them.
    expect([...typesAsked(null, [{ key: 'type', value: 'refactor' }])]).toContain('refactor');
    expect([...typesAsked(['defect'], [{ key: 'type', value: 'docs' }])].sort()).toEqual(['defect', 'docs']);
    // A clause on another key says nothing about which questions to ask.
    expect([...typesAsked(null, [{ key: 'kind', value: 'too big' }])].sort()).toEqual(['defect', 'lint', 'security']);
  });

  it('reads scan_types off the rule file, and says so when it is not a list', () => {
    expect(parseScanTypes('scan_types: [defect, Refactor]\nrules: []\n', 'perch.yaml')).toEqual(['defect', 'refactor']);
    // Omitted is not the same as empty: omitted takes the defaults, empty asks about nothing.
    expect(parseScanTypes('rules: []\n', 'perch.yaml')).toBe(null);
    expect(parseScanTypes('scan_types: []\nrules: []\n', 'perch.yaml')).toEqual([]);
    // A bare list is a list of rules and always was.
    expect(parseScanTypes('- name: r\n  ensure: x\n', 'perch.yaml')).toBe(null);
    expect(() => parseScanTypes('scan_types: defect\n', 'perch.yaml')).toThrow(/list of issue types/);
  });

  it('drops the questions for a type it was not asked about, and keeps their feeders', () => {
    const asked = questionSet().filter(question => question.each === 'method' && !question.kind
      && (!question.issue || typesAsked(null, []).has(question.issue.type)));
    const names = asked.map(question => question.name);
    // refactor and documented are the only two questions raising the advisory types, so they are what goes.
    expect(names).not.toContain('refactor');
    expect(names).not.toContain('documented');
    // does_what_it_claims is a defect: a method not doing what its name says is wrong, not untidy.
    expect(names).toContain('does_what_it_claims');
    // severity and kind raise nothing on their own. They feed the ones that do, so dropping them would take the band off a defect.
    expect(names).toContain('severity');
    expect(names).toContain('kind');
  });
});

describe('perch hunt', () => {
  it('refreshes method, file and search answers when the model or endpoint changes', async () => {
    const repo = await fixture();
    await writeFile(join(repo.root, 'perch.yaml'), 'rules:\n  - name: file-rule\n    where: src/a.js\n    ensure: Returns a number.\n  - name: search-rule\n    where: src/a.js\n    ensure_present: A function returning a number.\n');
    await commitAll(repo.root, 'file and search rules');
    const service = scriptedSystemOne({ project: { 'file-rule': 0.99, 'search-rule': 0.99 } });
    const requests = [];
    const fetchImpl = async (url, init) => {
      const { model, state, questions } = JSON.parse(init.body);
      requests.push({ url, model, state, questions });
      return new Response(JSON.stringify({ ...await service.ask(state, questions), model }));
    };
    const configurations = [
      { model: 'model-a', baseUrl: 'http://localhost:8123/first' },
      { model: 'model-b', baseUrl: 'http://localhost:8123/first' },
      { model: 'model-b', baseUrl: 'http://localhost:8123/second' },
    ];
    for (const configuration of configurations) {
      const systemOne = createSystemOne({ apiKey: 'fixture-key', fetchImpl, ...configuration });
      requests.length = 0;
      const run = await scanRepository(await withRevision(repo, { systemOne }));
      expect(run.failed).toEqual([]);
      expect(run.calls).toBe(4);
      expect(requests.some(request => request.questions['file-rule'])).toBe(true);
      expect(requests.some(request => request.questions['search-rule'])).toBe(true);
      expect(requests.every(request => request.url === configuration.baseUrl && request.model === configuration.model)).toBe(true);

      requests.length = 0;
      await scanRepository(await withRevision(repo, { systemOne }));
      expect(requests).toEqual([]);
    }
  });

  it('picks a window then a line when a method has more lines than a Choice can name', async () => {
    const lines = Array.from({ length: 400 }, (_, index) => `  x += ${index};`);
    const step = methodStep({ node: { path: 'a.rs', qualified_name: 'big', line: 1, end_line: 400 }, lines, callees: [], callers: [] });
    expect(step.questions.where).toBeUndefined();
    expect(Object.keys(step.questions.where_window.criteria)).toEqual(['W0001', 'W0002']);
    expect(step.windows).toHaveLength(2);
    expect(step.windows.every(window => window.length <= MAX_CHOICES)).toBe(true);
    expect(step.windows[0][0]).toBe('L0001');
    expect(step.windows.at(-1).at(-1)).toBe('L0400');
    const systemOne = scriptedSystemOne({ 'a.rs::big': { where_window: 'W0002', where: 'L0400' } });
    const located = await locateWhere({ systemOne, state: step.state, questions: step.questions, windows: step.windows });
    expect(located.answers.where.choice).toBe('L0400');
    expect(systemOne.calls).toHaveLength(2);
    expect(Object.keys(systemOne.calls[1].questions.where.criteria)).toEqual(step.windows[1]);
  });

  it('ranks a method by what its problems would cost, not how many it has', () => {
    // Two readings of the same shape: one would lose data, the other would be noticed by nobody.
    const reading = probabilities => ({ has_bug: 0.7, kind: { choice: 'boundary', probability: 1 }, severity: { probabilities },
      refactor: { choice: 'split', probability: 0.8, probabilities: { split: 0.8 } }, does_what_it_claims: 1, documented: 1 });
    const harmful = reading({ 0: 0, 1: 0, 2: 0, 3: 1 }), harmless = reading({ 0: 1, 1: 0, 2: 0, 3: 0 });
    expect(issueWeight(harmful)).toBeGreaterThan(issueWeight(harmless));
    // The whole distribution counts, so a band that only just won does not rank as if it were certain.
    const unsure = reading({ 0: 0.33, 1: 0, 2: 0.33, 3: 0.34 });
    expect(issueWeight(unsure)).toBeLessThan(issueWeight(harmful));
    expect(issueWeight(unsure)).toBeGreaterThan(issueWeight(harmless));
    // Design problems weigh as themselves either way: they are the ones no caller notices.
    expect(issueWeight(harmless)).toBeCloseTo(0.8);
  });

  it('walks every method once from riskiest down, logs each, and skips unchanged methods next time', async () => {
    const repo = await fixture({ scanTypes: ['defect', 'security', 'lint', 'refactor', 'docs'] });
    const systemOne = scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.9, where: 'L0004', kind: 'boundary', severity: 2, refactor: 'split', documented: 0.3 } });
    const seen = [], checkpoints = [];
    const ask = systemOne.ask.bind(systemOne);
    systemOne.ask = async (...args) => {
      checkpoints.push(await openStore(repo.out).latestRun());
      return ask(...args);
    };
    const hunt = await scanRepository(await withRevision(repo, { systemOne, parallel: 1, onFile: (path, findings) => seen.push({ path, findings }) }));

    expect(hunt.status).toBe('complete');
    expect(hunt.calls).toBe(4);
    expect(hunt.remaining).toBe(0);
    expect(checkpoints.filter(run => run.calls > 0).length).toBeGreaterThan(0);
    for (const checkpoint of checkpoints) {
      expect(checkpoint.status).toBe('running');
      expect(checkpoint.visited).toHaveLength(checkpoint.calls);
      expect(checkpoint.visited).toEqual(hunt.visited.slice(0, checkpoint.calls));
    }
    expect(await openStore(repo.out).latestRun()).toEqual(hunt);
    expect(hunt.visited.map(visit => visit.method)[0]).toBe('src/a.js::f');
    expect(new Set(hunt.visited.map(visit => visit.method))).toEqual(new Set(['src/a.js::f', 'src/a.js::g', 'src/b.js::h', 'src/b.js::k']));
    const f = hunt.visited.find(visit => visit.method === 'src/a.js::f');
    expect(f).toMatchObject({ status: 'read', id: expect.stringMatching(/^[0-9a-f]{8}$/), has_bug: 0.9, where: { line: 4 }, kind: { choice: 'boundary', probability: 0.8 }, severity: { level: 'P1' }, documented: 0.3, refactor: { choice: 'split' }, callees: expect.arrayContaining(['src/a.js::g', 'src/b.js::h']) });
    expect(f.kind.probabilities.boundary).toBe(0.8);
    expect(f.callers).toEqual([]);

    // The first request carried the method with tagged lines, its callees' source, and its callers' call sites.
    const first = systemOne.calls.find(call => call.method === 'src/a.js::f');
    expect(first.state.method.source).toContain('L0003| export function f(x) {');
    expect(first.state.calls.map(call => call.id).sort()).toEqual(['src/a.js::g', 'src/b.js::h']);
    expect(first.state.imports).toEqual(['h from ./b.js']);
    expect(first.state.module_scope).toBeNull();
    expect(first.state.calls.find(call => call.id === 'src/b.js::h').calls).toEqual(['k']);
    expect(first.state.call_graph).toEqual(expect.arrayContaining(['f -> g', 'f -> h', 'h -> k']));
    expect(first.state.method.metrics.risk_score).toBeTypeOf('number');
    expect(first.questions.misuse_0.instructions.callee).toBe(first.state.calls[0].id);
    expect(first.questions.kind.type).toBe('choice');
    expect(Object.keys(first.questions.kind.criteria)).toHaveLength(8);
    expect(first.questions.severity.type).toBe('score');
    expect(first.questions.refactor.type).toBe('choice');
    expect(Object.keys(first.questions.follow.criteria)).toEqual(expect.arrayContaining(['src/a.js::g', 'src/b.js::h', 'none']));
    expect(Object.keys(first.questions.where.criteria)).toEqual(['L0003', 'L0004', 'L0005', 'L0006', 'L0007']);
    const h = systemOne.calls.find(call => call.method === 'src/b.js::h');
    expect(h.state.called_by[0]).toMatchObject({ id: 'src/a.js::f', calls_method_at: 4 });
    expect(h.questions.misused_by_0.instructions.caller).toBe('src/a.js::f');

    // Every hunted method is one line in the events log, and nothing touched the working tree.
    const events = await openStore(repo.out).readLines(openStore(repo.out).scanPath);
    expect(events.map(event => event.method)).toEqual(hunt.visited.map(visit => visit.method));
    expect(existsSync(join(repo.out, 'workspaces'))).toBe(false);
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
    expect(f.where.text).toBe('if (x > 10) return g(x) + h(x);');
    // A file is handed over the moment every method in it has been read, so a long run says what it finds while it finds it.
    expect(seen.map(file => file.path).sort()).toEqual(['src/a.js', 'src/b.js']);
    expect(seen.every(file => file.findings.length)).toBe(true);
    expect(seen.find(file => file.path === 'src/a.js').findings.map(finding => finding.name).sort()).toEqual(['f', 'g']);

    const shown = formatScanReport(await openStore(repo.out).issues(), { color: false });
    // A run over a repository reads the way a linter does: the file, then one line per problem under it.
    expect(shown).toMatch(/^src\/a\.js$/m);
    expect(shown).toMatch(/^ {2}ID +Line {2}Severity {2}Type +Confidence {2}Problem +Method$/m);
    // The id on the row is the one perch issues and perch close take.
    // How sure is its own column, not a suffix on the problem.
    expect(shown).toMatch(new RegExp(`^ {2}${f.id} +\\d+ {2}P1 \\(\\d\\.\\d\\) {2}defect +\\d+% {2}off_by_one +f$`, 'm'));
    // A band is about a defect, so a row that is not about one does not claim it, and every column still lines up.
    expect(shown).toMatch(new RegExp(`^ {2}${f.id} +\\d+ {2}- +refactor +\\d+% {2}too_big +f$`, 'm'));
    // The run ends on how many problems there were and how many of them fail it, which is the number the exit code is.
    expect(shown).toMatch(/^[✖!] \d+ problems in \d+ files?, (\d+|all|none) failing$/m);
    expect(shown).not.toMatch(/^ID +Method/m);
    expect(hunt.to_read).toBe(4);

    // What the run comes back on. This fixture asked for refactor and docs, so they fail it like the defect does: a type worth
    // asking about is worth stopping for, and one that is not is left out of scan_types.
    const failing = gating(await openStore(repo.out).issues());
    expect(failing.map(issue => issue.label)).toContain('off_by_one');
    expect(failing.map(issue => issue.label)).toContain('too_big');

    // A second run over code nothing has touched asks nothing: the same state and the same questions have an answer already, and
    // asking again would spend a request to be told what is on disk while moving the numbers on an issue nobody has touched.
    const untouched = scriptedSystemOne();
    const again = await scanRepository(await withRevision(repo, { systemOne: untouched }));
    expect(again.calls).toBe(0);
    expect(again.carried).toBe(4);
    expect(untouched.calls).toHaveLength(0);
    expect(scanCount(again)).toMatch(/at commit [0-9a-f]{7}: 4 methods, read 0, 4 unchanged$/);
    // And what it carried is what it said before, to the percentage.
    expect((await openStore(repo.out).findings(0)).find(finding => finding.method === 'src/a.js::f').has_bug).toBe(0.9);

    // --paths is the universe: only what it names is considered at all, read or carried.
    const narrowed = await scanRepository(await withRevision(repo, { systemOne: scriptedSystemOne(), paths: ['src/b.js'] }));
    expect(narrowed.methods).toBe(2);
    expect(narrowed.visited.every(visit => visit.path === 'src/b.js')).toBe(true);
    // But the universe of what a run reads is not the universe of what perch knows. The file is written whole at the end, and
    // writing it with only what this run touched left a store that knew about one file and had forgotten the rest.
    expect((await openStore(repo.out).findings(0)).map(finding => finding.method).sort())
      .toEqual(['src/a.js::f', 'src/a.js::g', 'src/b.js::h', 'src/b.js::k']);
    expect((await openStore(repo.out).findings(0)).find(finding => finding.method === 'src/a.js::f').has_bug).toBe(0.9);

    // Editing a method is a different question, so it is asked again, and the answer that comes back is the one that stands.
    await writeFile(join(repo.root, 'src', 'a.js'), (await readFile(join(repo.root, 'src', 'a.js'), 'utf8')).replace('x > 10', 'x > 11'));
    await commitAll(repo.root, 'change f');
    const edited = scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.3 } });
    const fresh = await scanRepository(await withRevision(repo, { systemOne: edited, revision: await revision(repo.root) }));
    expect(edited.calls.map(call => call.method)).toContain('src/a.js::f');
    expect(fresh.carried).toBeLessThan(4);
    // 0.3 is below the floor, so f is no longer listed as a defect; asking for everything shows the answer did change.
    expect((await openStore(repo.out).findings()).some(finding => finding.method === 'src/a.js::f')).toBe(false);
    expect((await openStore(repo.out).findings(0)).find(finding => finding.method === 'src/a.js::f').has_bug).toBe(0.3);
  });


  it('scans a branch that touched no code, and still asks the rules about the files it touched', async () => {
    const repo = await fixture();
    await writeFile(join(repo.root, 'perch.yaml'), '- name: prose\n  where: "**/*.md"\n  ensure: A person wrote this.\n');
    await writeFile(join(repo.root, 'README.md'), '# a\n');
    await commitAll(repo.root, 'docs');
    // A pull request that only touched markdown has no method in scope. That used to be an error, which failed the run and took
    // the rules about files down with it, so the one thing it could have checked went unasked.
    const run = await scanRepository(await withRevision(repo, { systemOne: scriptedSystemOne(), paths: ['README.md'], revision: await revision(repo.root) }));
    expect(run.status).toBe('complete');
    expect(run.methods).toBe(0);
    // And the rule that covers what it did touch was asked.
    expect(run.coverage.find(item => item.name === 'prose')?.units).toBe(1);
  });

  it('reports what the run covered, not everything the store knows', async () => {
    // Asks for the advisory types too, so the methods outside the narrowed scope have something on them to leave out.
    const repo = await fixture({ scanTypes: ['defect', 'security', 'lint', 'refactor', 'docs'] });
    await scanRepository(await withRevision(repo, { systemOne: scriptedSystemOne() }));
    // Narrowed to one file, the report and its tally are about that file. They used to be about the whole store, so a run that
    // read nothing still ended on a count of problems in files it never opened, as though it had just found them.
    const { covers } = await import('../src/scan.js');
    const inScope = covers(['src/b.js']);
    const all = await openStore(repo.out).issues();
    expect(all.some(finding => !inScope(finding.path))).toBe(true);
    const kept = all.filter(finding => inScope(finding.path));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every(finding => finding.path === 'src/b.js')).toBe(true);
    // A run with no narrowing covers everything, so nothing is hidden by the same predicate.
    expect(all.filter(finding => covers([])(finding.path)).length).toBe(all.length);
  });

  it('finishes the file it is in, then follows the neighbor the model points at', async () => {
    const repo = await fixture();
    const systemOne = scriptedSystemOne({ 'src/a.js::f': { follow: 'src/b.js::h' }, 'src/b.js::h': { follow: 'src/b.js::k' } });
    const seen = [];
    const run = await scanRepository(await withRevision(repo, { systemOne, parallel: 1, onFile: path => seen.push(path) }));
    // A run over a repository is read file by file, so the rest of src/a.js comes before the method the model pointed at in
    // src/b.js. What the model said still decides which file is opened next.
    expect(run.visited.map(visit => visit.method)).toEqual(['src/a.js::f', 'src/a.js::g', 'src/b.js::h', 'src/b.js::k']);
    // Which is what lets a file be reported while the run is still going, rather than everything arriving at the end.
    expect(seen).toEqual(['src/a.js', 'src/b.js']);
    expect(run.calls).toBe(4);
    expect(run.remaining).toBe(0);
  });

  it('carries on past a method it cannot read, and stops when nothing can be read at all', async () => {
    const repo = await fixture();
    const other = await fixture();
    const scripted = scriptedSystemOne();
    // One method the service will not answer for, the way an oversized request comes back.
    const flaky = { id: scripted.id, calls: scripted.calls,
      ask: (state, questions) => (state.method?.name === 'h' ? Promise.reject(new Error('max_tokens_exceeded')) : scripted.ask(state, questions)) };
    const run = await scanRepository(await withRevision(repo, { systemOne: flaky, parallel: 1 }));
    expect(run.status).toBe('complete');
    expect(run.calls).toBe(3);
    expect(run.failed).toHaveLength(1);
    expect(run.failed[0]).toMatchObject({ name: 'h', path: 'src/b.js', status: 'failed', error: 'max_tokens_exceeded' });
    // The other three were read and are listed; the failure is on the record, not in the results.
    expect((await openStore(repo.out).findings(0)).some(finding => finding.name === 'h')).toBe(false);
    // What doctor is for: what the run was doing, and the methods it could not read with the error, grouped by the error.
    const doctor = formatDoctor({ versions: { perch: '0.1.0', node: 'v22', platform: 'test' }, scan: null, run, out: repo.out, color: false,
      checks: [{ name: 'key', ok: true, found: 'PERCH_API_KEY, 8 characters' }, { name: 'git', ok: false, found: 'not on the path', fix: 'install git' }] });
    // Whether perch can run at all comes first, with what to do about anything that cannot.
    expect(doctor).toMatch(/^✓ key {2}PERCH_API_KEY, 8 characters$/m);
    expect(doctor).toMatch(/^✗ git {2}not on the path$/m);
    expect(doctor).toMatch(/^ {2}git: install git$/m);
    // Which run, in one line, so the rest of it can be about what went wrong.
    expect(doctor).toMatch(/^[0-9a-f]{8} {2}complete {2}\d+[smhd] ago {2}[0-9a-f]{7}$/m);
    // What went wrong and nothing else. What the run covered and which questions fired are the scan's own report; somebody
    // opening doctor has something broken and wants the line that says so.
    expect(doctor).not.toMatch(/^methods {2}/m);
    expect(doctor).not.toMatch(/^rules {4}/m);
    expect(doctor).not.toMatch(/^questions$/m);
    expect(doctor).not.toMatch(/^issues /m);
    expect(doctor).not.toMatch(/^tokens /m);
    // Every method it could not read, with the error beside it.
    expect(doctor).toMatch(/^1 could not be read$/m);
    expect(doctor).toMatch(/^ {2}method +where +error$/m);
    expect(doctor).toMatch(/^ {2}h +src\/b\.js:\d+ +max_tokens_exceeded$/m);
    // It is pasted into a bug report as it stands, so nothing it prints is source.
    expect(doctor).not.toContain('function');

    // Every method failing is a broken key or a service that is down, and reading the rest of the repository will not fix it.
    // A repository nothing has read yet, since a run with every answer already on disk asks nothing and so cannot fail.
    const broken = { id: 'dead', calls: [], ask: () => Promise.reject(new Error('HTTP 401')) };
    await expect(scanRepository(await withRevision(other, { systemOne: broken, parallel: 2 }))).rejects.toThrow('methods in a row could not be read; last error: HTTP 401');
  });

  it('reads a method too long for one request in passes, and merges what they found', () => {
    const lines = Array.from({ length: 3000 }, (_, index) => `  total += weigh(item_${index}, options, context);`);
    const node = { path: 'src/big.js', qualified_name: 'giant', line: 1, end_line: 3000, metrics: { risk_score: 90 } };
    const steps = methodSteps({ node, lines, callees: [], callers: [] });
    expect(steps.length).toBeGreaterThan(1);
    // Every pass fits, they run in order, and each overlaps the last so a defect on the seam is whole in one of them.
    for (const step of steps) expect(countTokens(JSON.stringify(step.state), { disallowedSpecial: new Set() })).toBeLessThanOrEqual(STATE_BUDGET);
    for (const [index, step] of steps.slice(1).entries()) expect(step.covers.line).toBeLessThan(steps[index].covers.end_line);
    expect(steps.at(-1).covers.end_line).toBe(3000);
    // Only the first pass carries the neighborhood: callers and callees are about the method, not about a slice of it.
    expect(Object.keys(steps[0].questions)).toContain('follow');
    expect(steps[1].state.module_scope).toBeNull();

    // The worst defect anywhere in the method is the method's defect; the first pass still speaks for its shape.
    const whole = { has_bug: 0.2, where: { line: 4 }, kind: { choice: 'boundary' }, exposed: 0.3, injection: 0.1, use_after_free: 0.4, refactor: { choice: 'split' } };
    const later = { has_bug: 0.8, where: { line: 2600 }, kind: { choice: 'resource_leak' }, exposed: 0.9, injection: 0.9, use_after_free: 0.2, refactor: { choice: 'none' } };
    const merged = mergeAnswers([whole, later]);
    expect(merged).toMatchObject({ has_bug: 0.8, where: { line: 2600 }, kind: { choice: 'resource_leak' }, exposed: 0.9, refactor: { choice: 'split' }, passes: 2 });
    // A class a later pass rated lower keeps the higher reading: a slice that saw less is not evidence of less.
    expect(merged).toMatchObject({ injection: 0.9, use_after_free: 0.4 });
    // Gated on exposure, injection is 0.9 x 0.9; use_after_free is wrong on its own terms, but at 0.4 it is under the floor
    // the class carries, so the vulnerability that stands is the one that cleared it.
    expect(securityOf(merged)).toEqual({ kind: 'injection', probability: 0.9 * 0.9 });
  });

  it('reads everything in scope and never questions test methods', async () => {
    const repo = await fixture();
    const systemOne = scriptedSystemOne();
    // There is no cap on what a run reads: a number that stopped partway would leave a report that looks complete and is not.
    const hunt = await scanRepository(await withRevision(repo, { systemOne }));
    expect(hunt.calls).toBe(4);
    expect(hunt.visited).toHaveLength(4);
    expect(systemOne.calls.every(call => !call.method.startsWith('test/'))).toBe(true);
  });

  it('questions several methods at once and finds a finding by id prefix', async () => {
    const repo = await fixture();
    let inFlight = 0, peak = 0;
    const scripted = scriptedSystemOne();
    const systemOne = { id: scripted.id, calls: scripted.calls, async ask(state, questions) { peak = Math.max(peak, ++inFlight); await new Promise(resolve => setTimeout(resolve, 20)); inFlight--; return scripted.ask(state, questions); } };
    const hunt = await scanRepository(await withRevision(repo, { systemOne, parallel: 4 }));
    expect(hunt.calls).toBe(4);
    expect(peak).toBeGreaterThan(1);
    const store = openStore(repo.out);
    const [first] = hunt.visited;
    expect((await store.findFinding(first.id.slice(0, 4))).method).toBe(first.method);
    await expect(store.findFinding('zzzz')).rejects.toThrow('no finding zzzz');
  });
});
