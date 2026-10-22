import { realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { scanRepository } from '../src/scan.js';
import { parseFilters } from '../src/questions.js';
import { readRules } from '../src/units.js';
import { main } from '../src/cli.js';
import { commitAll, makeFixture, makeGraphFixture, scriptedSystemOne } from './helpers.js';

const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** One rule of each shape: one asked inside a method's request, one about a file, and a search of each kind. */
const RULES = `rules:
  - name: returns-number
    where: src/**/*.js
    each: method
    ensure: Returns a number.
  - name: readme-plain
    where: README.md
    ensure: A person wrote this.
  - name: has-logger
    where: src/**/*.js
    ensure_present: A logger.
  - name: no-debugger
    where: src/**/*.js
    ensure_absent: A debugger statement.
`;

async function fixture() {
  const root = await makeGraphFixture();
  cleanups.push(root);
  await writeFile(join(root, 'perch.yaml'), RULES);
  await writeFile(join(root, 'README.md'), '# graph\n');
  await commitAll(root, 'rules');
  return { root, revision: await revision(root), out: join(root, '.perch') };
}

/** What a request was about: a method, a unit inside a file, or a whole file. */
const about = state => (state.method ? `${state.method.path}::${state.method.name}` : `${state.path}${state.name ? `::${state.name}` : ''}`);

/** Every request a scan sent, as what it was about and the questions in it, sorted so the order of the walk does not matter. */
async function sent(repo, filter = '') {
  const filters = parseFilters(filter, await readRules(repo.root, repo.revision));
  const systemOne = scriptedSystemOne();
  await scanRepository({ ...repo, analyzer, systemOne, filters, paths: [] });
  return systemOne.calls.map(call => `${about(call.state)}: ${Object.keys(call.questions).sort().join(' ')}`).sort();
}

const METHODS = ['src/a.js::f', 'src/a.js::g', 'src/b.js::h', 'src/b.js::k'];

/** What a scan of the fixture asked before a filter decided what is asked, recorded from that code. */
const UNFILTERED = [
  'README.md: readme-plain',
  'src/a.js: has-logger',
  'src/a.js: no-debugger',
  'src/a.js::f: bug_edge_case follow has_bug kind returns-number severity',
  'src/a.js::g: bug_edge_case follow has_bug kind returns-number severity',
  'src/b.js: has-logger',
  'src/b.js: no-debugger',
  'src/b.js::h: bug_edge_case follow has_bug kind returns-number severity',
  'src/b.js::k: bug_edge_case follow has_bug kind returns-number severity',
];

describe('what a filtered scan asks', () => {
  it('asks the same requests as before when there is no filter', async () => {
    expect(await sent(await fixture())).toEqual(UNFILTERED);
  });

  it('asks no defect question and no rule for type=security', async () => {
    const requests = await sent(await fixture(), 'type=security');
    // One request per method, and none for the file rule or the searches.
    expect(requests.map(request => request.split(': ')[0])).toEqual(METHODS);
    for (const request of requests) {
      const names = request.split(': ')[1].split(' ');
      expect(names.filter(name => ['has_bug', 'bug_edge_case', 'kind', 'returns-number'].includes(name))).toEqual([]);
      expect(names).toEqual(expect.arrayContaining(['cwe_89', 'cwe_79', 'severity', 'follow']));
      expect(names.filter(name => !name.startsWith('cwe_'))).toEqual(['follow', 'severity']);
    }
  });

  it('asks has_bug, bug_edge_case, kind and severity and no rule for kind=off_by_one', async () => {
    expect(await sent(await fixture(), 'kind=off_by_one')).toEqual(METHODS.map(method => `${method}: bug_edge_case follow has_bug kind severity`));
  });

  it('asks only the rule a rule= filter names, whichever shape it is', async () => {
    const repo = await fixture();
    expect(await sent(repo, 'rule=returns-number')).toEqual(METHODS.map(method => `${method}: follow returns-number`));
    expect(await sent(repo, 'rule=readme-plain')).toEqual(['README.md: readme-plain']);
    expect(await sent(repo, 'rule=has-logger')).toEqual(['src/a.js: has-logger', 'src/b.js: has-logger']);
  });

  it('asks every rule and none of perch\'s own questions for type=lint, the search that declares no issue included', async () => {
    const repo = await fixture();
    expect(await sent(repo, 'type=lint')).toEqual([
      'README.md: readme-plain',
      'src/a.js: has-logger',
      'src/a.js: no-debugger',
      'src/a.js::f: follow returns-number',
      'src/a.js::g: follow returns-number',
      'src/b.js: has-logger',
      'src/b.js: no-debugger',
      'src/b.js::h: follow returns-number',
      'src/b.js::k: follow returns-number',
    ]);
    // A search is listed as a lint issue under its own name, so kind= can name it as well.
    expect(await sent(repo, 'kind=has-logger')).toEqual(['src/a.js: has-logger', 'src/b.js: has-logger']);
  });

  it('asks the whole set for severity=P1', async () => {
    expect(await sent(await fixture(), 'severity=P1')).toEqual(UNFILTERED);
  });

  it('asks the union of its clauses, so a severity beside a type asks the whole set and that type', async () => {
    const requests = await sent(await fixture(), 'type=security,severity=P1');
    expect(requests.filter(request => !request.includes('::'))).toEqual(UNFILTERED.filter(request => !request.includes('::')));
    for (const request of requests.filter(item => item.includes('::'))) expect(request.split(': ')[1].split(' ')).toEqual(expect.arrayContaining(['has_bug', 'returns-number', 'cwe_89']));
  });
});

describe('the exit code of a filtered scan', () => {
  it('fails only on what the filter lists', async () => {
    const repo = await realpath(await makeFixture());
    cleanups.push(repo);
    // A rule that never fails a run, and a defect that does.
    await writeFile(join(repo, 'perch.yaml'), 'rules:\n  - name: clamp-note\n    where: src/**/*.js\n    each: method\n    gate: false\n    ensure: Clamp says what it does with NaN.\n');
    await commitAll(repo, 'a rule that does not gate');
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    const service = scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.95, 'clamp-note': 0.1 } });
    vi.stubGlobal('fetch', async (url, init) => {
      const { state, questions } = JSON.parse(init.body);
      return new Response(JSON.stringify(await service.ask(state, questions)));
    });
    const out = [], err = [];
    const io = { stdout: text => out.push(text), stderr: text => err.push(text), env: { HOME: repo, PERCH_API_KEY: 'key', PERCH_BASE_URL: 'https://api.typesafe.ai/v1/systemone' } };
    expect(await main(['scan', repo, '--out', join(repo, '.perch')], io), err.join('\n')).toBe(3);
    // The defect is still on the method's row, carried from the run before, but this run neither asked nor listed it.
    expect(await main(['scan', repo, '--filter', 'rule=clamp-note', '--out', join(repo, '.perch')], io), err.join('\n')).toBe(0);
    expect(service.calls.at(-1).questions).not.toHaveProperty('has_bug');
    expect(out.join('\n').split('\n').at(-1)).toBe('! 1 problem in 1 file, none failing');
    expect(await main(['scan', repo, '--filter', 'type=defect', '--out', join(repo, '.perch')], io), err.join('\n')).toBe(3);
  });
});
