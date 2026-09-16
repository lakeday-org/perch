import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { runHunt } from '../src/hunt.js';
import { huntStep, locateWhere, MAX_CHOICES } from '../src/questions.js';
import { openStore } from '../src/store.js';
import { formatHunt } from '../src/report.js';
import { commitAll, fixtureOptions, makeGraphFixture, scriptedSystemOne } from './helpers.js';

const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const root = await makeGraphFixture();
  cleanups.push(root);
  return { root, revision: await revision(root), out: join(root, '.perch') };
}

/** Hunt options that re-read HEAD, since a test may commit between hunts. */
const withRevision = async (repo, extra) => fixtureOptions(repo, { analyzer, revision: await revision(repo.root), ...extra });

describe('perch hunt', () => {
  it('picks a window then a line when a method has more lines than a Choice can name', async () => {
    const lines = Array.from({ length: 400 }, (_, index) => `  x += ${index};`);
    const step = huntStep({ node: { path: 'a.rs', qualified_name: 'big', line: 1, end_line: 400 }, lines, callees: [], callers: [] });
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

  it('walks every method once from riskiest down, logs each, and skips unchanged methods next time', async () => {
    const repo = await fixture();
    const systemOne = scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.9, where: 'L0004', kind_boundary: 0.8, severity: 2, refactor: 'split', misdocumented: 0.7 } });
    const hunt = await runHunt(await withRevision(repo, { systemOne }));

    expect(hunt.status).toBe('complete');
    expect(hunt.calls).toBe(4);
    expect(hunt.skipped).toBe(0);
    expect(hunt.remaining).toBe(0);
    expect(hunt.visited.map(visit => visit.method)[0]).toBe('src/a.js::f');
    expect(new Set(hunt.visited.map(visit => visit.method))).toEqual(new Set(['src/a.js::f', 'src/a.js::g', 'src/b.js::h', 'src/b.js::k']));
    const f = hunt.visited.find(visit => visit.method === 'src/a.js::f');
    expect(f).toMatchObject({ status: 'hunted', id: expect.stringMatching(/^[0-9a-f]{8}$/), has_bug: 0.9, reachable: 0.9, where: { line: 4 }, kind: { kind: 'boundary', probability: 0.8 }, severity: { level: 'major' }, misdocumented: 0.7, refactor: { refactor: 'split' }, callees: expect.arrayContaining(['src/a.js::g', 'src/b.js::h']) });
    expect(f.kinds.boundary).toBe(0.8);
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
    expect(Object.keys(first.questions).filter(key => key.startsWith('kind_'))).toHaveLength(8);
    expect(first.questions.refactor.type).toBe('choice');
    expect(Object.keys(first.questions.follow.criteria)).toEqual(expect.arrayContaining(['src/a.js::g', 'src/b.js::h', 'none']));
    expect(Object.keys(first.questions.where.criteria)).toEqual(['L0003', 'L0004', 'L0005', 'L0006', 'L0007']);
    const h = systemOne.calls.find(call => call.method === 'src/b.js::h');
    expect(h.state.called_by[0]).toMatchObject({ id: 'src/a.js::f', calls_method_at: 4 });
    expect(h.questions.misused_by_0.instructions.caller).toBe('src/a.js::f');

    // Every hunted method is one line in the events log, and nothing touched the working tree.
    const events = await openStore(repo.out).readEvents();
    expect(events.map(event => event.method)).toEqual(hunt.visited.map(visit => visit.method));
    expect(existsSync(join(repo.out, 'workspaces'))).toBe(false);
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
    expect(f.where.text).toBe('if (x > 10) return g(x) + h(x);');
    expect(formatHunt(hunt)).toContain('1 have issues (1 defect, 0 design only), 3 look clean.');
    expect(formatHunt(hunt)).toMatch(new RegExp(`${f.id}  f +src/a.js:4 +boundary 90%, split 80%, misdocumented 70% +major +open`));
    expect(formatHunt(hunt)).not.toContain('Design work');

    // A second hunt skips everything, without a single model call.
    const again = await runHunt(await withRevision(repo, { systemOne: scriptedSystemOne() }));
    expect(again.calls).toBe(0);
    expect(again.skipped).toBe(4);

    // Changing one method makes only that method huntable again.
    await writeFile(join(repo.root, 'src', 'b.js'), (await readFile(join(repo.root, 'src', 'b.js'), 'utf8')).replace('return x - 1;', 'return x - 2;'));
    await commitAll(repo.root, 'change k');
    const third = scriptedSystemOne();
    const changed = await runHunt(await withRevision(repo, { systemOne: third }));
    expect(changed.calls).toBe(1);
    expect(changed.skipped).toBe(3);
    expect(third.calls[0].method).toBe('src/b.js::k');

    // --force questions everything again, and issues reports the latest answer per method.
    const forced = scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.3 } });
    expect((await runHunt(await withRevision(repo, { systemOne: forced, force: true }))).calls).toBe(4);
    const findings = await openStore(repo.out).findings(0.25);
    expect(findings.map(finding => [finding.method, finding.has_bug])).toEqual([['src/a.js::f', 0.3]]);
  });

  it('does not list a defect when the flagged line is not reachable', async () => {
    const repo = await fixture();
    const hunt = await runHunt(await withRevision(repo, { systemOne: scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.9, where: 'L0004', kind_boundary: 0.8, reachable: 0.1 } }) }));
    const f = hunt.visited.find(visit => visit.method === 'src/a.js::f');
    expect(f).toMatchObject({ has_bug: 0.9, reachable: 0.1 });
    expect(await openStore(repo.out).findings(0.5)).toEqual([]);
  });

  it('follows the neighbor the model points at before the next riskiest method', async () => {
    const repo = await fixture();
    const systemOne = scriptedSystemOne({ 'src/a.js::f': { follow: 'src/b.js::h' }, 'src/b.js::h': { follow: 'src/b.js::k' } });
    const hunt = await runHunt(await withRevision(repo, { systemOne, budget: 3, parallel: 1 }));
    expect(hunt.visited.map(visit => visit.method)).toEqual(['src/a.js::f', 'src/b.js::h', 'src/b.js::k']);
    expect(hunt.calls).toBe(3);
    expect(hunt.remaining).toBe(1);
  });

  it('stops at the budget and never questions test methods', async () => {
    const repo = await fixture();
    const systemOne = scriptedSystemOne();
    const hunt = await runHunt(await withRevision(repo, { systemOne, budget: 2 }));
    expect(hunt.calls).toBe(2);
    expect(hunt.visited).toHaveLength(2);
    expect(systemOne.calls.every(call => !call.method.startsWith('test/'))).toBe(true);
  });

  it('questions several methods at once and finds a finding by id prefix', async () => {
    const repo = await fixture();
    let inFlight = 0, peak = 0;
    const scripted = scriptedSystemOne();
    const systemOne = { id: scripted.id, calls: scripted.calls, async ask(state, questions) { peak = Math.max(peak, ++inFlight); await new Promise(resolve => setTimeout(resolve, 20)); inFlight--; return scripted.ask(state, questions); } };
    const hunt = await runHunt(await withRevision(repo, { systemOne, parallel: 4 }));
    expect(hunt.calls).toBe(4);
    expect(peak).toBeGreaterThan(1);
    const store = openStore(repo.out);
    const [first] = hunt.visited;
    expect((await store.findFinding(first.id.slice(0, 4))).method).toBe(first.method);
    await expect(store.findFinding('zzzz')).rejects.toThrow('no finding zzzz');
  });
});
