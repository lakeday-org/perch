import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { runScan } from '../src/scan.js';
import { formatScan } from '../src/report.js';
import { fixtureOptions, makeFixture, makeGraphFixture } from './helpers.js';

const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture(make = makeFixture) {
  const root = await make();
  cleanups.push(root);
  return { root, revision: await revision(root), out: join(root, '.perch') };
}

describe('perch scan', () => {
  it('ranks methods at the revision without a worktree or a model', async () => {
    const repo = await fixture();
    const scan = await runScan(fixtureOptions(repo, { analyzer }));
    expect(scan.status).toBe('complete');
    expect(scan.coverage).toMatchObject({ parsed: 2, parse_failures: 0, excluded: 1 });
    expect(scan.candidates.map(candidate => candidate.id)).toEqual(['src/clamp.js::clamp']);
    const [file] = scan.files.filter(file => file.path === 'src/clamp.js');
    expect(file.methods[0]).toMatchObject({ id: 'src/clamp.js::clamp', name: 'clamp', line: 1, end_line: 5 });
    expect(file.methods[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(file.methods[0].metrics.risk_score).toBeTypeOf('number');
    expect(existsSync(join(repo.out, 'workspaces'))).toBe(false);
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
    expect((await git(['worktree', 'list', '--porcelain'], repo.root)).match(/^worktree /gm)).toHaveLength(1);
    expect(formatScan(scan)).toContain('src/clamp.js:1');

    const again = await runScan(fixtureOptions(repo, { analyzer }));
    expect(again.id).toBe(scan.id);
    expect(again.created_at).toBe(scan.created_at);
  });

  it('records calls and imports per file and keeps test methods out of the ranking', async () => {
    const repo = await fixture(makeGraphFixture);
    const scan = await runScan(fixtureOptions(repo, { analyzer }));
    const a = scan.files.find(file => file.path === 'src/a.js');
    expect(a.imports).toEqual([{ module: './b.js', name: 'h', alias: 'h' }]);
    expect(a.calls.map(call => `${call.from}>${call.name}`).sort()).toEqual(['src/a.js::f>g', 'src/a.js::f>g', 'src/a.js::f>h', 'src/a.js::f>h']);
    expect(scan.candidates.map(candidate => candidate.id)).not.toContain('test/a.test.js::<anonymous>');
    expect(scan.candidates.every(candidate => candidate.id.startsWith('src/'))).toBe(true);
    expect(scan.candidates[0].id).toBe('src/a.js::f');
  });

  it('limits analysis to --paths', async () => {
    const repo = await fixture();
    const scan = await runScan(fixtureOptions(repo, { analyzer, paths: ['test'] }));
    expect(scan.coverage.parsed).toBe(1);
    expect(scan.candidates).toEqual([]);
    await expect(runScan(fixtureOptions(repo, { analyzer, paths: ['nowhere'] }))).rejects.toThrow('No supported source files');
  });
});
