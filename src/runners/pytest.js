/**
 * pytest, run by perch: once over the whole suite with per-test coverage, to learn which tests run each line, and then once per
 * mutant over the tests that run it, to learn which of them fail. It runs in a copy of the repository at the commit being read,
 * with the Python on PATH, so an activated virtual environment is the one used, and the copy ahead of the installed package on
 * the import path, so a test imports the copy's code and not an editable install of the original.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readJunit } from '../test-reports.js';
import { sandboxed } from './sandbox.js';

export const name = 'pytest';

/**
 * A command's exit code and output, or `timedOut` when it ran past `timeout` milliseconds and was stopped. With `writable`, it
 * runs sandboxed, able to write only there and to the temporary directory. Whatever it started is killed with it when it ends,
 * however it ends: a process a mutated test left running must not outlive the run that started it.
 */
export function exec(command, args, { cwd, env = {}, timeout = 0, writable = null } = {}) {
  const run = writable ? sandboxed(command, args, writable) : { command, args };
  return new Promise(resolve => {
    const child = spawn(run.command, run.args, { cwd, env: { ...process.env, PWD: cwd, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone already */ } };
    let output = '', timedOut = false;
    const keep = chunk => { output = (output + chunk).slice(-20000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    // The whole process group: pytest's own children, a server a test started, go with it.
    const timer = timeout ? setTimeout(() => { timedOut = true; killGroup(); }, timeout) : null;
    child.on('error', error => { if (timer) clearTimeout(timer); resolve({ code: null, output: error.message, timedOut }); });
    child.on('close', code => { if (timer) clearTimeout(timer); killGroup(); resolve({ code, output, timedOut }); });
  });
}

/** Whether pytest can be run here: a Python on PATH with pytest and pytest-cov. Null with the reason when not. */
export async function available({ root }) {
  for (const python of ['python', 'python3']) {
    const found = await exec(python, ['-c', 'import pytest, pytest_cov'], { cwd: root });
    if (found.code === 0) return { python };
  }
  return { python: null, reason: 'no Python on PATH has pytest and pytest-cov; activate the project\'s environment, or install pytest-cov in it' };
}

/** The copy's code ahead of anything installed: its root, and its src/ for a src layout. */
const importPath = copy => ({ PYTHONPATH: [copy, join(copy, 'src'), process.env.PYTHONPATH].filter(Boolean).join(':') });

/**
 * A JUnit testcase as pytest's node id and as perch's test id: `tests.test_x.TestCart` and `adds[2]` are the node
 * `tests/test_x.py::TestCart::adds[2]` and the test `tests/test_x.py::TestCart.adds`. The file is the longest prefix of the
 * classname that is a file in the copy.
 */
function ids(testcase, copy) {
  const parts = String(testcase.classname ?? '').split('.');
  for (let at = parts.length; at > 0; at--) {
    const path = `${parts.slice(0, at).join('/')}.py`;
    if (!existsSync(join(copy, path))) continue;
    const owner = parts.slice(at);
    return { node: `${path}::${[...owner, testcase.name].join('::')}`, test: `${path}::${[...owner, testcase.name.replace(/\[.*$/s, '')].join('.')}` };
  }
  return null;
}

/** Each testcase's result by node id, with the perch test it belongs to. */
async function results(xml, copy) {
  const read = readJunit(await readFile(xml, 'utf8'), xml);
  const byNode = new Map();
  for (const testcase of read) {
    const id = ids(testcase, copy);
    if (id) byNode.set(id.node, { test: id.test, status: testcase.status, time: testcase.time ?? 0 });
  }
  return byNode;
}

/**
 * The whole suite once, with each test's lines recorded as its own coverage context. Returns the coverage data file, every
 * testcase's result and time, and how long the run took.
 */
export async function coverageRun({ copy, python, scratch, timeout = 0 }) {
  const data = join(scratch, '.coverage'), xml = join(scratch, 'baseline.xml');
  const started = Date.now();
  const run = await exec(python, ['-m', 'pytest', '-p', 'no:cacheprovider', `--cov=${copy}`, '--cov-context=test', '--cov-report=', `--junitxml=${xml}`],
    { cwd: copy, env: { ...importPath(copy), COVERAGE_FILE: data }, timeout, writable: [copy, scratch] });
  if (!existsSync(xml) || !existsSync(data)) throw new Error(`pytest did not run the suite (exit ${run.code}): ${run.output.trim().split('\n').slice(-5).join(' | ')}`);
  return { data, xml, results: await results(xml, copy), seconds: (Date.now() - started) / 1000 };
}

/**
 * The given tests, by node id, against the copy as it stands: one process, every test's result. `invalid` when pytest could not
 * collect them, which a mutant that breaks an import makes happen; `timeout` when they ran past the limit.
 */
export async function runTests({ copy, python, scratch, nodes, timeout, tag }) {
  const xml = join(scratch, `run-${tag}.xml`);
  await rm(xml, { force: true });
  const run = await exec(python, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--no-cov', `--junitxml=${xml}`, ...nodes],
    { cwd: copy, env: importPath(copy), timeout, writable: [copy, scratch] });
  if (run.timedOut) return { status: 'timeout' };
  if (!existsSync(xml)) return { status: 'invalid', output: run.output };
  const found = await results(xml, copy);
  // Exit 2 is an interrupted run, 3 an internal error, 4 a usage error: what was collected, if anything, says nothing.
  if ([2, 3, 4].includes(run.code) && ![...found.values()].some(item => item.status === 'passed' || item.status === 'failed')) return { status: 'invalid', output: run.output };
  return { status: 'ran', results: found };
}
