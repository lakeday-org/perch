import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { mergeAnswers, scanRepository } from '../src/hunt.js';
import { huntStep, huntSteps, issueWeight, locateWhere, MAX_CHOICES, STATE_BUDGET } from '../src/questions.js';
import { openStore } from '../src/store.js';
import { formatDoctor, formatScanRun, scanCount } from '../src/report.js';
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

  it('ranks a method by what its problems would cost, not how many it has', () => {
    // Two readings of the same shape: one would lose data, the other would be noticed by nobody.
    const reading = probabilities => ({ has_bug: 0.5, kind: { kind: 'boundary', probability: 1 }, severity: { probabilities },
      refactor: { refactor: 'split', probabilities: { split: 0.5 } }, does_what_it_claims: 1, misdocumented: 0 });
    const harmful = reading({ 0: 0, 1: 0, 2: 0, 3: 1 }), harmless = reading({ 0: 1, 1: 0, 2: 0, 3: 0 });
    expect(issueWeight(harmful)).toBeGreaterThan(issueWeight(harmless));
    // The whole distribution counts, so a band that only just won does not rank as if it were certain.
    const unsure = reading({ 0: 0.33, 1: 0, 2: 0.33, 3: 0.34 });
    expect(issueWeight(unsure)).toBeLessThan(issueWeight(harmful));
    expect(issueWeight(unsure)).toBeGreaterThan(issueWeight(harmless));
    // Design problems weigh as themselves either way: they are the ones no caller notices.
    expect(issueWeight(harmless)).toBeCloseTo(0.5);
  });

  it('walks every method once from riskiest down, logs each, and skips unchanged methods next time', async () => {
    const repo = await fixture();
    const systemOne = scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.9, where: 'L0004', kind: 'boundary', severity: 2, refactor: 'split', misdocumented: 0.7 } });
    const hunt = await scanRepository(await withRevision(repo, { systemOne }));

    expect(hunt.status).toBe('complete');
    expect(hunt.calls).toBe(4);
    expect(hunt.skipped).toBe(0);
    expect(hunt.remaining).toBe(0);
    expect(hunt.visited.map(visit => visit.method)[0]).toBe('src/a.js::f');
    expect(new Set(hunt.visited.map(visit => visit.method))).toEqual(new Set(['src/a.js::f', 'src/a.js::g', 'src/b.js::h', 'src/b.js::k']));
    const f = hunt.visited.find(visit => visit.method === 'src/a.js::f');
    expect(f).toMatchObject({ status: 'hunted', id: expect.stringMatching(/^[0-9a-f]{8}$/), has_bug: 0.9, where: { line: 4 }, kind: { kind: 'boundary', probability: 0.8 }, severity: { level: 'P1' }, misdocumented: 0.7, refactor: { refactor: 'split' }, callees: expect.arrayContaining(['src/a.js::g', 'src/b.js::h']) });
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
    const events = await openStore(repo.out).readEvents();
    expect(events.map(event => event.method)).toEqual(hunt.visited.map(visit => visit.method));
    expect(existsSync(join(repo.out, 'workspaces'))).toBe(false);
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
    expect(f.where.text).toBe('if (x > 10) return g(x) + h(x);');
    const shown = formatScanRun(hunt, await openStore(repo.out).issues());
    // The run prints the table and nothing else; what it read is context, and goes to stderr.
    expect(shown).toMatch(/^ID +Method +Location/m);
    expect(shown).not.toMatch(/^Scanned /m);
    expect(hunt.budget).toBeNull();
    expect(hunt.to_read).toBe(4);

    expect(shown).toMatch(new RegExp(`${f.id}  f +src/a.js:\\d+ +defect +off_by_one \\d+%, too_big \\d+%.* +P1 \\(\\d\\.\\d\\)$`));

    // A second hunt skips everything, without a single model call.
    const again = await scanRepository(await withRevision(repo, { systemOne: scriptedSystemOne() }));
    expect(again.calls).toBe(0);
    expect(again.skipped).toBe(4);
    expect(again.to_read).toBe(0);
    expect(scanCount(again)).toMatch(/at commit [0-9a-f]{7}: 4 methods, read 0, 4 unchanged$/);
    expect(formatScanRun(again, [])).toBe('Nothing matches.');

    // Changing one method makes only that method huntable again.
    await writeFile(join(repo.root, 'src', 'b.js'), (await readFile(join(repo.root, 'src', 'b.js'), 'utf8')).replace('return x - 1;', 'return x - 2;'));
    await commitAll(repo.root, 'change k');
    const third = scriptedSystemOne();
    const changed = await scanRepository(await withRevision(repo, { systemOne: third }));
    expect(changed.calls).toBe(1);
    expect(changed.skipped).toBe(3);
    expect(third.calls[0].method).toBe('src/b.js::k');

    // --force questions everything again, and issues reports the latest answer per method.
    const forced = scriptedSystemOne({ 'src/a.js::f': { has_bug: 0.3 } });
    expect((await scanRepository(await withRevision(repo, { systemOne: forced, force: true }))).calls).toBe(4);
    // 0.3 is below the floor, so f is no longer listed as a defect; asking for everything shows the answer did change.
    expect((await openStore(repo.out).findings()).some(finding => finding.method === 'src/a.js::f')).toBe(false);
    const findings = await openStore(repo.out).findings(0);
    expect(findings[0].method).toBe('src/a.js::f');
    expect(findings[0].has_bug).toBe(0.3);
  });


  it('follows the neighbor the model points at before the next riskiest method', async () => {
    const repo = await fixture();
    const systemOne = scriptedSystemOne({ 'src/a.js::f': { follow: 'src/b.js::h' }, 'src/b.js::h': { follow: 'src/b.js::k' } });
    const hunt = await scanRepository(await withRevision(repo, { systemOne, budget: 3, parallel: 1 }));
    expect(hunt.visited.map(visit => visit.method)).toEqual(['src/a.js::f', 'src/b.js::h', 'src/b.js::k']);
    expect(hunt.calls).toBe(3);
    expect(hunt.remaining).toBe(1);
  });

  it('carries on past a method it cannot read, and stops when nothing can be read at all', async () => {
    const repo = await fixture();
    const scripted = scriptedSystemOne();
    // One method the service will not answer for, the way an oversized request comes back.
    const flaky = { id: scripted.id, calls: scripted.calls,
      ask: (state, questions) => (state.method?.name === 'h' ? Promise.reject(new Error('max_tokens_exceeded')) : scripted.ask(state, questions)) };
    const hunt = await scanRepository(await withRevision(repo, { systemOne: flaky, parallel: 1 }));
    expect(hunt.status).toBe('complete');
    expect(hunt.calls).toBe(3);
    expect(hunt.failed).toHaveLength(1);
    expect(hunt.failed[0]).toMatchObject({ name: 'h', path: 'src/b.js', status: 'failed', error: 'max_tokens_exceeded' });
    // The other three were read and are listed; the failure is on the record, not in the results.
    expect((await openStore(repo.out).findings(0)).some(finding => finding.name === 'h')).toBe(false);
    const doctor = formatDoctor({ versions: { perch: '0.1.0', node: 'v22', platform: 'test' }, scan: null, hunt, out: repo.out, findings: 3 });
    expect(doctor).toContain('1 method could not be read:');
    expect(doctor).toContain('1x max_tokens_exceeded');
    expect(doctor).toContain('h at src/b.js:');

    // Every method failing is a broken key or a service that is down, and reading the rest of the repository will not fix it.
    const broken = { id: 'dead', calls: [], ask: () => Promise.reject(new Error('HTTP 401')) };
    await expect(scanRepository(await withRevision(repo, { systemOne: broken, parallel: 2, force: true }))).rejects.toThrow('methods in a row could not be read; last error: HTTP 401');
  });

  it('reads a method too long for one request in passes, and merges what they found', () => {
    const lines = Array.from({ length: 3000 }, (_, index) => `  total += weigh(item_${index}, options, context);`);
    const node = { path: 'src/big.js', qualified_name: 'giant', line: 1, end_line: 3000, metrics: { risk_score: 90 } };
    const steps = huntSteps({ node, lines, callees: [], callers: [] });
    expect(steps.length).toBeGreaterThan(1);
    // Every pass fits, they run in order, and each overlaps the last so a defect on the seam is whole in one of them.
    for (const step of steps) expect(JSON.stringify(step.state).length).toBeLessThanOrEqual(STATE_BUDGET);
    for (const [index, step] of steps.slice(1).entries()) expect(step.covers.line).toBeLessThan(steps[index].covers.end_line);
    expect(steps.at(-1).covers.end_line).toBe(3000);
    // Only the first pass carries the neighbourhood: callers and callees are about the method, not about a slice of it.
    expect(Object.keys(steps[0].questions)).toContain('follow');
    expect(steps[1].state.module_scope).toBeNull();

    // The worst defect anywhere in the method is the method's defect; the first pass still speaks for its shape.
    const whole = { has_bug: 0.2, where: { line: 4 }, kind: { kind: 'boundary' }, exposed: 0.3, securities: { injection: 0.1, leak: 0.4 }, refactor: { refactor: 'split' } };
    const later = { has_bug: 0.8, where: { line: 2600 }, kind: { kind: 'resource_leak' }, exposed: 0.9, securities: { injection: 0.7, leak: 0.2 }, refactor: { refactor: 'none' } };
    const merged = mergeAnswers([whole, later]);
    expect(merged).toMatchObject({ has_bug: 0.8, where: { line: 2600 }, kind: { kind: 'resource_leak' }, exposed: 0.9, refactor: { refactor: 'split' }, passes: 2 });
    expect(merged.securities).toEqual({ injection: 0.7, leak: 0.4 });
    expect(merged.security).toEqual({ kind: 'injection', probability: 0.7 });
  });

  it('stops at the budget and never questions test methods', async () => {
    const repo = await fixture();
    const systemOne = scriptedSystemOne();
    const hunt = await scanRepository(await withRevision(repo, { systemOne, budget: 2 }));
    expect(hunt.calls).toBe(2);
    expect(hunt.visited).toHaveLength(2);
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
