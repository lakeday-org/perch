import { describe, expect, it } from 'vitest';
import { OUTPUT_LIMIT, runScript } from '../src/shell.js';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('shell', () => {
  it('kills the whole process group on timeout and leaves no orphan', async () => {
    const started = Date.now();
    const result = await runScript('sleep 30 & echo "child=$!"; wait', { timeoutMs: 500 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).not.toBe(0);
    const child = Number(/child=(\d+)/.exec(result.stdout)[1]);
    expect(child).toBeGreaterThan(0);
    for (let i = 0; i < 40 && alive(child); i++) await wait(50);
    expect(alive(child)).toBe(false);
  });

  it('bounds stdout and stderr to the last 64 KiB', async () => {
    const result = await runScript('head -c 200000 /dev/zero | tr "\\0" a; printf START; head -c 100000 /dev/zero | tr "\\0" b >&2; printf END >&2', { timeoutMs: 10_000 });
    expect(result.exit_code).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBe(OUTPUT_LIMIT);
    expect(result.stdout.endsWith('START')).toBe(true);
    expect(Buffer.byteLength(result.stderr)).toBe(OUTPUT_LIMIT);
    expect(result.stderr.endsWith('END')).toBe(true);
  });

  it('reports the exit code and does not wait on background children of a finished script', async () => {
    const started = Date.now();
    const result = await runScript('sleep 30 & echo done; exit 3', { timeoutMs: 10_000 });
    expect(result.exit_code).toBe(3);
    expect(result.stdout.trim()).toBe('done');
    expect(result.timed_out).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
