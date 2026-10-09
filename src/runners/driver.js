/**
 * One process a session's commands all run under, started once and sandboxed once: a runner whose framework starts a process per
 * mutant sends each command here rather than starting it sandboxed itself. Each command runs in its own process group, killed
 * with everything it started when it ends or passes its time limit.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { sandboxed } from './sandbox.js';

const DRIVER = `import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
let open = 0, ended = false;
// Replies go out on a descriptor of their own: whatever else writes to standard output cannot be mistaken for one. JSON allows
// the Unicode line and paragraph separators raw in a string, and a line reader splits on them, so they go out escaped.
const say = message => writeSync(3, JSON.stringify(message).replace(/\\u2028/g, '\\\\u2028').replace(/\\u2029/g, '\\\\u2029') + '\\n');
const settle = () => { if (ended && !open) process.exit(0); };
createInterface({ input: process.stdin }).on('line', line => {
  const { id, command, args, cwd, env, timeout, whole } = JSON.parse(line);
  open++;
  const child = spawn(command, args, { cwd, env: { ...process.env, PWD: cwd, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', timedOut = false;
  // A run whose results are in what it prints keeps all of it; any other, the end, where an error says what went wrong.
  const keep = chunk => { output = whole ? output + chunk : (output + chunk).slice(-20000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const timer = timeout ? setTimeout(() => { timedOut = true; kill(); }, timeout) : null;
  let done = false;
  const finish = code => { if (done) return; done = true; if (timer) clearTimeout(timer); kill(); open--; say({ id, code, output, timedOut }); settle(); };
  child.on('error', error => { output += error.message; finish(null); });
  child.on('exit', kill);
  child.on('close', finish);
}).on('close', () => { ended = true; settle(); });
`;

/** The driver for one session, writing only under `writable` and the temporary directory. */
export async function startDriver({ scratch, writable }) {
  const file = join(scratch, 'perch-driver.mjs');
  await writeFile(file, DRIVER);
  const run = sandboxed(process.execPath, [file], writable);
  const child = spawn(run.command, run.args, { detached: true, stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const waiting = new Map();
  let next = 0;
  const exited = new Promise(resolve => child.on('close', resolve));
  exited.then(code => { for (const { reject } of waiting.values()) reject(new Error(`perch's command driver stopped (exit ${code}): ${stderr.trim()}`)); });
  createInterface({ input: child.stdio[3] }).on('line', line => {
    const message = JSON.parse(line);
    const call = waiting.get(message.id);
    waiting.delete(message.id);
    call?.resolve(message);
  });
  return {
    /** A command's exit code and output, or `timedOut`. */
    exec(command, args, { cwd, env = {}, timeout = 0, whole = false }) {
      const id = next++;
      const answer = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({ id, command, args, cwd, env, timeout, whole })}\n`);
      return answer;
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 10000);
      await exited;
      clearTimeout(timer);
    },
  };
}
