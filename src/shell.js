/** Run model-written scripts locally in their own process group with bounded output. */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

export const OUTPUT_LIMIT = 64 * 1024;

function tail(limit = OUTPUT_LIMIT) {
  let chunks = [], total = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      total += chunk.length;
      while (total > limit && chunks.length) {
        const excess = total - limit;
        if (chunks[0].length <= excess) total -= chunks.shift().length;
        else { chunks[0] = chunks[0].subarray(excess); total -= excess; }
      }
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

export function runScript(script, { cwd = process.cwd(), timeoutMs = 300_000, env = process.env, verbose = false, log = message => console.error(message) } = {}) {
  if (verbose) log(`[perch] bash -c (cwd ${cwd}, timeout ${Math.round(timeoutMs / 1000)}s)\n${script}`);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn('bash', ['-c', script, 'perch'], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = tail(), stderr = tail();
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    let timedOut = false, exit = null;
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      exit = { code, signal };
      // Background descendants must not outlive the script or hold its pipes open.
      killGroup(child.pid);
    });
    child.on('close', (code, signal) => {
      const finalCode = exit?.code ?? code, finalSignal = exit?.signal ?? signal;
      resolve({
        exit_code: finalCode ?? (finalSignal ? 128 + (constants.signals[finalSignal] ?? 0) : -1),
        signal: finalSignal ?? null,
        timed_out: timedOut,
        stdout: stdout.text(),
        stderr: stderr.text(),
        duration_ms: Date.now() - started,
      });
    });
  });
}

export function createShell({ verbose = false, log } = {}) {
  return { run: (script, options = {}) => runScript(script, { verbose, log, ...options }) };
}
