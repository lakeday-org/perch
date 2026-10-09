/**
 * Long-lived worker processes, each sandboxed once when it starts: a framework loaded once in each, and every mutant run inside
 * one, as Stryker keeps its test runners. A worker takes a command on file descriptor 3 and answers on 4, leaving standard input
 * and output to the tests. One that passes its time limit, a mutant that made a loop never end, is killed with everything it
 * started, and a fresh one takes its place.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { sandboxed } from './sandbox.js';

/** The plumbing every worker script starts with: commands in on 3, answers out on 4, separators escaped as the driver's are. */
export const WORKER_IO = `import { createReadStream, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
const __perch_say = message => writeSync(4, JSON.stringify(message).replace(/\\u2028/g, '\\\\u2028').replace(/\\u2029/g, '\\\\u2029') + '\\n');
const __perch_commands = createInterface({ input: createReadStream(null, { fd: 3 }) });`;

/**
 * `count` workers running `script` in `cwd`, each with `env`, or what `env(index)` gives it. `run(message, timeout)` gives a free
 * worker the message and resolves to its answer, or to `{ timedOut: true }`, or `{ crashed: true, output }` when it died; either
 * way the worker is replaced by one with the same index.
 */
export async function startWorkers({ script, command = null, count, scratch, writable, cwd, env = {} }) {
  // A Node script talks on descriptors 3 and 4; any other program, a JVM, on standard input and on standard output lines that
  // start with `@@perch`, everything else it prints being the tests'.
  const file = script ? join(scratch, `perch-worker-${Math.random().toString(36).slice(2)}.mjs`) : null;
  if (script) await writeFile(file, script);
  const program = command ?? { command: process.execPath, args: [file] };
  const stdio = !script;
  const free = [], waiting = [];
  let closing = false;

  const launch = index => new Promise((resolve, reject) => {
    const run = sandboxed(program.command, program.args, writable);
    const own = typeof env === 'function' ? env(index) : env;
    const child = spawn(run.command, run.args, { cwd, detached: true, env: { ...process.env, PWD: cwd, ...own }, stdio: stdio ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    const worker = { child, index, output: '', pending: null, input: stdio ? child.stdin : child.stdio[3] };
    const keep = chunk => { worker.output = (worker.output + chunk).slice(-20000); };
    if (!stdio) child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let ready = false;
    createInterface({ input: stdio ? child.stdout : child.stdio[4] }).on('line', line => {
      if (stdio && !line.startsWith('@@perch\t')) { keep(`${line}\n`); return; }
      const message = JSON.parse(stdio ? line.slice('@@perch\t'.length) : line);
      if (message.ready) { ready = true; resolve(worker); return; }
      const pending = worker.pending;
      worker.pending = null;
      pending?.resolve(message);
    });
    child.on('close', code => {
      worker.dead = true;
      if (!ready) reject(new Error(`a test worker would not start (exit ${code}): ${worker.output.trim().split('\n').slice(-6).join(' | ')}`));
      worker.pending?.resolve({ crashed: true, output: worker.output });
      worker.pending = null;
    });
  });
  const kill = worker => { try { process.kill(-worker.child.pid, 'SIGKILL'); } catch { /* gone */ } };
  const take = () => (free.length ? Promise.resolve(free.pop()) : new Promise(resolve => waiting.push(resolve)));
  const give = worker => { if (waiting.length) waiting.shift()(worker); else free.push(worker); };

  for (let at = 0; at < count; at++) free.push(await launch(at));
  return {
    async run(message, timeout) {
      let worker = await take();
      if (worker.dead) worker = await launch(worker.index);
      worker.output = '';
      const answer = new Promise(resolve => { worker.pending = { resolve }; });
      worker.input.write(`${JSON.stringify(message)}\n`);
      let timer;
      const limit = timeout ? new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), timeout); }) : null;
      const reply = await (limit ? Promise.race([answer, limit]) : answer);
      clearTimeout(timer);
      if (reply.timedOut || reply.crashed) {
        kill(worker);
        if (!closing) give(await launch(worker.index));
        return reply;
      }
      give(worker);
      return reply;
    },
    async close() {
      closing = true;
      for (const worker of free) { worker.input.end(); kill(worker); }
    },
  };
}
