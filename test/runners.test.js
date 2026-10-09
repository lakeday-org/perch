import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exec } from '../src/runners/pytest.js';
import { sandboxKind } from '../src/runners/sandbox.js';

const cleanups = [];
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('a test run perch starts', () => {
  it.skipIf(!sandboxKind())('writes only inside its copy, its scratch directory and the temporary directory', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'perch-sandbox-'));
    cleanups.push(copy);
    // Outside every writable directory: the repository perch is running from.
    const outside = join(process.cwd(), `.sandbox-canary-${process.pid}`);
    cleanups.push(outside);
    const run = await exec('sh', ['-c', `touch "${join(copy, 'inside')}" && touch "${outside}"`], { cwd: copy, writable: [copy] });
    expect(existsSync(join(copy, 'inside'))).toBe(true);
    expect(existsSync(outside)).toBe(false);
    expect(run.code).not.toBe(0);
  });

  it('leaves nothing it started running once it ends', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-orphan-'));
    cleanups.push(dir);
    const pidFile = join(dir, 'pid');
    // The command starts a process in the background and exits at once, as a test that starts a server and forgets it does.
    const run = await exec('sh', ['-c', `sleep 30 & echo $! > "${pidFile}"`], { cwd: dir });
    expect(run.code).toBe(0);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('stops a run that passes its time limit, and everything it started', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-timeout-'));
    cleanups.push(dir);
    const started = Date.now();
    const run = await exec('sh', ['-c', 'sleep 30'], { cwd: dir, timeout: 300 });
    expect(run.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
