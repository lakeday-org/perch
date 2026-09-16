import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { createShell } from '../src/shell.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { runScan } from '../src/scan.js';
import { formatSummary } from '../src/report.js';
import { buggySource, countingShell, makeFixture, scriptedModel } from './helpers.js';

const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const root = await makeFixture();
  cleanups.push(root);
  return { root, revision: await revision(root), out: join(root, '.perch') };
}

const scanOptions = (repo, extra = {}) => ({ root: repo.root, revision: repo.revision, out: repo.out, analyzer, fix: true, candidates: 4, paths: [], ...extra });

describe('perch scan', () => {
  it('proves a planted bug, fixes it, and never repeats work on a rerun', async () => {
    const repo = await fixture();
    const model = scriptedModel(), shell = countingShell(createShell());
    const scan = await runScan(scanOptions(repo, { model, shell }));

    expect(scan.status).toBe('complete');
    expect(scan.candidates.map(candidate => candidate.path)).toEqual(['src/clamp.js']);
    expect(scan.issues).toHaveLength(1);
    const [issue] = scan.issues;
    expect(issue).toMatchObject({ title: 'clamp ignores the upper bound', priority: 'P2', path: 'src/clamp.js', regression_path: 'test/clamp.regression.test.js' });
    expect(issue.evidence[0].quote).toMatch(/AssertionError/);
    expect(scan.fixes).toHaveLength(1);
    const [fix] = scan.fixes;
    expect(fix.status).toBe('ready');
    expect(fix.review.approved).toBe(true);
    expect(fix.quality.accepted).toBe(true);
    expect(existsSync(fix.patch_path)).toBe(true);
    const patch = await readFile(fix.patch_path, 'utf8');
    expect(patch).toContain('+  if (v > hi) return hi;');
    expect(patch).toContain('+++ b/test/clamp.regression.test.js');
    expect(model.calls.map(call => call.id)).toEqual(['preparation-0', 'triage-0', 'fix-0-0', 'review-0']);
    expect(shell.calls.length).toBeGreaterThan(0);

    // The patch applies cleanly to a fresh checkout of the scanned revision.
    const fresh = await mkdtemp(join(tmpdir(), 'perch-fresh-'));
    cleanups.push(fresh);
    await git(['clone', '-q', repo.root, fresh]);
    await git(['apply', '--check', fix.patch_path], fresh);
    await git(['apply', fix.patch_path], fresh);
    const applied = await createShell().run('node --test', { cwd: fresh, timeoutMs: 60_000 });
    expect(applied.exit_code).toBe(0);

    // The operator's tree is untouched: no worktree left behind, no status noise, original source intact.
    expect(await readFile(join(repo.root, 'src', 'clamp.js'), 'utf8')).toBe(buggySource);
    expect(existsSync(join(repo.root, 'test', 'clamp.regression.test.js'))).toBe(false);
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
    expect(existsSync(join(repo.out, 'workspaces', scan.id))).toBe(false);
    expect((await git(['worktree', 'list', '--porcelain'], repo.root)).match(/^worktree /gm)).toHaveLength(1);

    // Rerunning the identical scan is a no-op: no model calls, no command executions.
    const model2 = scriptedModel(), shell2 = countingShell(createShell());
    const again = await runScan(scanOptions(repo, { model: model2, shell: shell2 }));
    expect(again.id).toBe(scan.id);
    expect(again.issues).toHaveLength(1);
    expect(again.fixes[0].status).toBe('ready');
    expect(model2.calls).toHaveLength(0);
    expect(shell2.calls).toHaveLength(0);

    // Even with the scan record gone, the journal alone replays every step without new work.
    await rm(join(scan.out, 'scan.json'));
    const model3 = scriptedModel(), shell3 = countingShell(createShell());
    const replayed = await runScan(scanOptions(repo, { model: model3, shell: shell3 }));
    expect(replayed.status).toBe('complete');
    expect(replayed.fixes[0].status).toBe('ready');
    expect(model3.calls).toHaveLength(0);
    expect(shell3.calls).toHaveLength(0);
    expect(formatSummary(replayed)).toContain('READY clamp ignores the upper bound');
  });

  it('records no issue when triage finds nothing', async () => {
    const repo = await fixture();
    const model = scriptedModel({ triage: () => ({ found: false, title: '', reason: '', priority: 'P3', regression_path: '', regression: '', command: '' }) });
    const scan = await runScan(scanOptions(repo, { model, shell: createShell() }));
    expect(scan.status).toBe('complete');
    expect(scan.issues).toEqual([]);
    expect(scan.fixes).toEqual([]);
    expect(model.calls.map(call => call.id)).toEqual(['preparation-0', 'triage-0']);
    expect(JSON.parse(await readFile(join(scan.out, 'issues.json'), 'utf8'))).toEqual([]);
  });

  it('rejects a regression that does not fail on the base', async () => {
    const repo = await fixture();
    const passing = 'import test from "node:test"; test("nothing", () => {});\n';
    const model = scriptedModel({ triage: () => ({ found: true, title: 'phantom', reason: 'none', priority: 'P3',
      regression_path: 'test/phantom.test.js', regression: passing, command: 'node --test test/phantom.test.js' }) });
    const scan = await runScan(scanOptions(repo, { model, shell: createShell(), fix: false }));
    expect(scan.issues).toEqual([]);
    expect(scan.rejected).toHaveLength(1);
    expect(scan.rejected[0].reason).toBe('Regression did not demonstrate a behavioral failure');
  });
});
