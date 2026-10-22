import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chance, compact, score } from './core.mjs';

const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
const manifest = [{ repo: 'app', pr: 1 }, { repo: 'app', pr: 2 }, { repo: 'app', pr: 3 }];
const run = (pr, methods, code = 3) => [`app-${pr}`, { pr: `app-${pr}`, code, cost: 0.01, methods }];

describe('the Greptile benchmark score', () => {
  it('catches a pull request when a function flagged strictly above the cutoff holds one of its golden bugs', () => {
    const labels = [{ repo: 'app', pr: 1, methods: ['a.js::f'] }, { repo: 'app', pr: 2, methods: ['b.js::g'] }, { repo: 'app', pr: 2, methods: [] }];
    const runs = new Map([
      run(1, [{ method: 'a.js::f', has_bug: 0.9, bug_edge_case: 0.1 }, { method: 'a.js::h', has_bug: 0.2 }]),
      run(2, [{ method: 'b.js::g', has_bug: 0.6, bug_edge_case: 0.6 }, { method: 'b.js::k', review_cleanup: 0.95 }]),
      run(3, [{ method: 'c.js::m', has_bug: 0.99 }]),
    ]);
    const result = score(manifest, labels, runs, 0.6);
    // Pull request 2's bug was answered at exactly 0.6, which is not above it; pull request 3 has no golden bug in a function.
    expect(result).toMatchObject({ caught: 1, of: 2, golden: 1, golden_of: 2, flags: 3, read: 5, median_flags: 1, missing: [] });
    expect(score(manifest, labels, runs, 0.5)).toMatchObject({ caught: 2, golden: 2 });
  });

  it('grades the known bug as Greptile did: out of every pull request, a failed scan or a bug in no function a miss', () => {
    const known = [{ repo: 'app', pr: 1, methods: ['a.js::h'] }, { repo: 'app', pr: 2, methods: ['b.js::k'] }, { repo: 'app', pr: 3, methods: [] }];
    const runs = new Map([run(1, [{ method: 'a.js::h', has_bug: 0.7 }]), run(2, [{ method: 'b.js::k', has_bug: 0.6 }], 1), run(3, [{ method: 'c.js::m', has_bug: 0.99 }])]);
    // Pull request 2's scan failed and pull request 3's known bug sits in no function, so only pull request 1 can count.
    expect(score(manifest, [], runs, 0.6, known)).toMatchObject({ known: 1, known_of: 3 });
    expect(score(manifest, [], runs, 0.7, known)).toMatchObject({ known: 0, known_of: 3 });
  });

  it('counts a failed scan as missing rather than as a pull request with nothing flagged', () => {
    const runs = new Map([run(1, [], 1), run(2, [{ method: 'b.js::g', has_bug: 0.9 }])]);
    expect(score(manifest, [{ repo: 'app', pr: 2, methods: ['b.js::g'] }], runs, 0.6)).toMatchObject({ prs: 1, missing: ['app-1', 'app-3'], caught: 1, of: 1 });
  });

  it('puts the chance of a random flag landing on a buggy function at what drawing without replacement gives', () => {
    expect(chance(4, 1, 2)).toBeCloseTo(0.5);
    expect(chance(4, 1, 0)).toBe(0);
    expect(chance(3, 1, 3)).toBe(1);
  });

  it('keeps the bug answers, the reported methods and the cost of a run, and nothing of a failed one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perch-greptile-')); temporary.push(dir);
    const read = (method, answers) => JSON.stringify({ type: 'read', method, root: '/home/someone/app', risk: 40, passes: 2, kind: { choice: 'boundary' }, ...answers });
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ code: 3, seconds: 2 }));
    await fs.writeFile(path.join(dir, 'scan.jsonl'), [read('a.js::f', { has_bug: 0.2, bug_edge_case: 0.1 }), JSON.stringify({ type: 'run' }), read('a.js::f', { has_bug: 0.7, review_cleanup: 0.4 })].join('\n') + '\n');
    await fs.writeFile(path.join(dir, 'stdout.json'), JSON.stringify({ issues: [{ method: 'a.js::f' }, { method: 'a.js::f' }], usage: { 'gpt-6-luna': { cost: 0.002 }, other: { cost: 0.001 } } }));
    expect(await compact('test', { repo: 'app', pr: 1 }, dir)).toEqual({ config: 'test', pr: 'app-1', code: 3, seconds: 2,
      usage: { 'gpt-6-luna': { cost: 0.002 }, other: { cost: 0.001 } }, cost: 0.003, reported: ['a.js::f'], methods: [{ method: 'a.js::f', has_bug: 0.7, review_cleanup: 0.4 }] });
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ code: 'memory', seconds: 90 }));
    expect(await compact('test', { repo: 'app', pr: 1 }, dir)).toMatchObject({ code: 'memory', reported: [], methods: [], cost: 0 });
  });
});
