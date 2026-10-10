/**
 * pytest, run by perch: once over the whole suite with per-test coverage, to learn which tests run each line, and then as a
 * server that collected the suite once and runs each mutant in a forked child, against the tests that run it. It runs in a copy
 * of the repository at the commit being read, with the Python on PATH, so an activated virtual environment is the one used, and
 * the copy ahead of the installed package on the import path, so a test imports the copy's code and not an editable install of
 * the original.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isAbsolute, join } from 'node:path';
import { readCoverageDb, readJunit } from '../test-reports.js';
import { killGroup, sandboxed } from './sandbox.js';
import { SERVER } from './pytest-server.js';

export const name = 'pytest';
/** The languages whose code and tests a pytest run covers. */
export const languages = new Set(['python']);
/** One copy whatever the parallelism: mutants are swapped in memory, in forked children, and never written to it. */
export const copiesFor = () => 1;

/**
 * A command's exit code and output, or `timedOut` when it ran past `timeout` milliseconds and was stopped. With `writable`, it
 * runs sandboxed, able to write only there and to the temporary directory. Whatever it started is killed with it when it ends,
 * however it ends: a process a mutated test left running must not outlive the run that started it.
 */
export function exec(command, args, { cwd, env = {}, timeout = 0, writable = null } = {}) {
  const run = writable ? sandboxed(command, args, writable) : { command, args };
  return new Promise(resolve => {
    const child = spawn(run.command, run.args, { cwd, env: { ...process.env, PWD: cwd, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const killAll = () => killGroup(child.pid);
    let output = '', timedOut = false;
    const keep = chunk => { output = (output + chunk).slice(-20000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    // The whole process group: pytest's own children, a server a test started, go with it.
    const timer = timeout ? setTimeout(() => { timedOut = true; killAll(); }, timeout) : null;
    child.on('error', error => { if (timer) clearTimeout(timer); resolve({ code: null, output: error.message, timedOut }); });
    // Whatever it left running goes when it exits: a child still holding its output open would keep 'close' from ever coming.
    child.on('exit', killAll);
    child.on('close', code => { if (timer) clearTimeout(timer); killAll(); resolve({ code, output, timedOut }); });
  });
}

/** Whether pytest can be run here: a Python on PATH with pytest and pytest-cov. Null with the reason when not. */
export async function available({ root }) {
  for (const python of ['python', 'python3']) {
    const found = await exec(python, ['-c', 'import pytest, pytest_cov'], { cwd: root });
    if (found.code === 0) return { python };
  }
  return { reason: 'no Python on PATH has pytest and pytest-cov; activate the project\'s environment, or install pytest-cov in it' };
}

/** The copy's code ahead of anything installed: its root, and its src/ for a src layout. */
const importPath = copy => ({ PYTHONPATH: [copy, join(copy, 'src'), process.env.PYTHONPATH].filter(Boolean).join(':') });

/**
 * pytest's node id as perch's test id: the node `tests/test_x.py::TestCart::adds[2]` is a case of the test
 * `tests/test_x.py::TestCart.adds`, the file then its classes and function, dotted, without the parameters.
 */
export const testOf = nodeid => {
  const [path, ...rest] = nodeid.replace(/\[.*\]$/s, '').split('::');
  return `${path}::${rest.join('.')}`;
};

/**
 * A JUnit testcase as pytest's node id: `tests.test_x.TestCart` and `adds[2]` are the node `tests/test_x.py::TestCart::adds[2]`.
 * The file is the longest prefix of the classname that is a file in the copy.
 */
function nodeOf(testcase, copy) {
  const parts = String(testcase.classname ?? '').split('.');
  for (let at = parts.length; at > 0; at--) {
    const path = `${parts.slice(0, at).join('/')}.py`;
    if (existsSync(join(copy, path))) return [path, ...parts.slice(at), testcase.name].join('::');
  }
  return null;
}

/** Each testcase's result by node id, with the perch test it belongs to. */
async function results(xml, copy) {
  const read = readJunit(await readFile(xml, 'utf8'), xml);
  const byNode = new Map();
  for (const testcase of read) {
    const node = nodeOf(testcase, copy);
    if (node) byNode.set(node, { test: testOf(node), status: testcase.status, time: testcase.time ?? 0 });
  }
  return byNode;
}

/**
 * The lines each test ran, by perch's test id, from coverage.py's data file. pytest-cov names each test's lines by its node id
 * and the phase, `tests/test_x.py::adds|run`; lines run under no test, at import, are no test's. coverage.py writes paths
 * absolute unless the project asks for relative ones; either way a path outside the copy is not the repository's.
 */
export async function executedBy(data, copy) {
  const executed = new Map();
  for (const file of (await readCoverageDb(data)).files) {
    const path = isAbsolute(file.path) ? (file.path.startsWith(`${copy}/`) ? file.path.slice(copy.length + 1) : null) : file.path;
    if (path === null) continue;
    for (const [context, lines] of file.contexts) {
      if (context === '') continue;
      const test = testOf(context.replace(/\|(setup|run|teardown)$/, ''));
      if (!executed.has(test)) executed.set(test, new Map());
      const into = executed.get(test);
      if (!into.has(path)) into.set(path, new Set());
      for (const line of lines) into.get(path).add(line);
    }
  }
  return executed;
}

/**
 * The whole suite once, with each test's lines recorded as its own coverage context. Returns the lines each test ran, every
 * testcase's result and time by node id, and how long the run took.
 */
export async function coverageRun({ copy, scratch, tool: { python }, timeout = 0 }) {
  const data = join(scratch, '.coverage'), xml = join(scratch, 'baseline.xml');
  const started = Date.now();
  const run = await exec(python, ['-m', 'pytest', '-p', 'no:cacheprovider', `--cov=${copy}`, '--cov-context=test', '--cov-report=', `--junitxml=${xml}`],
    { cwd: copy, env: { ...importPath(copy), COVERAGE_FILE: data }, timeout, writable: [copy, scratch] });
  if (!existsSync(xml) || !existsSync(data)) throw new Error(`pytest did not run the suite (exit ${run.code}): ${run.output.trim().split('\n').slice(-5).join(' | ')}`);
  return { executed: await executedBy(data, copy), results: await results(xml, copy), seconds: (Date.now() - started) / 1000 };
}

/**
 * The mutant server: pytest collects the suite once in the copy, sandboxed once for the whole run, and then runs each mutant it
 * is sent in a forked child, `parallel` at a time. `run` takes the mutated file's text and the tests to run, by node id, and
 * returns `ran` with each test's result, `timeout`, or `invalid` when the mutated code could not be loaded.
 */
export async function session({ copies: [copy], tool: { python }, parallel }) {
  await writeFile(join(copy.scratch, 'perch_server.py'), SERVER);
  const command = sandboxed(python, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--no-cov', '-p', 'perch_server'], [copy.dir, copy.scratch]);
  const path = importPath(copy.dir).PYTHONPATH;
  const child = spawn(command.command, command.args, { cwd: copy.dir, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    // A library that touched macOS's frameworks before the fork would otherwise abort the child.
    env: { ...process.env, PWD: copy.dir, PYTHONPATH: `${copy.scratch}:${path}`, PERCH_ROOT: copy.dir, PERCH_PARALLEL: String(parallel), OBJC_DISABLE_INITIALIZE_FORK_SAFETY: 'YES' } });
  let output = '';
  const keep = chunk => { output = (output + chunk).slice(-20000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const waiting = new Map();
  let ready, failed;
  const started = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  const exited = new Promise(resolve => child.on('close', resolve));
  exited.then(code => {
    const error = new Error(`pytest's mutant server stopped (exit ${code}): ${output.trim().split('\n').slice(-5).join(' | ')}`);
    failed(error);
    for (const { reject } of waiting.values()) reject(error);
  });
  createInterface({ input: child.stdio[4] }).on('line', line => {
    const message = JSON.parse(line);
    if (message.ready) { ready(message); return; }
    const call = waiting.get(message.id);
    waiting.delete(message.id);
    call?.resolve(message);
  });
  // A server that fails while it collects takes anything it started with it.
  try { await started; } catch (error) { killGroup(child.pid); throw error; }
  let next = 0;
  return {
    async run({ path: file, source, method, mutant, nodes, timeout, bail = false }) {
      const id = next++;
      const answer = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
      child.stdio[3].write(`${JSON.stringify({ id, path: file, source: source.toString('utf8'), name: method.node.qualified_name.split('.').at(-1), line: method.node.line,
        signature: mutant.statements.length === 0, nodes, timeout, bail })}\n`);
      const reply = await answer;
      const timing = { elapsed: reply.elapsed, apply: reply.apply, child: reply.child };
      if (reply.status !== 'ran') return { status: reply.status, error: reply.error, timing };
      return { status: 'ran', timing, results: new Map(reply.results.map(item => [item.node, { test: testOf(item.node), status: item.status }])) };
    },
    async close() {
      child.stdio[3].end();
      const timer = setTimeout(() => killGroup(child.pid), 10000);
      await exited;
      clearTimeout(timer);
      killGroup(child.pid);
    },
  };
}
