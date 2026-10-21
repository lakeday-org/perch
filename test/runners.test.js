import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exec, executedBy, testOf } from '../src/runners/pytest.js';
import { sandboxKind } from '../src/runners/sandbox.js';
import { startDriver } from '../src/runners/driver.js';
import { startWorkers, WORKER_IO } from '../src/runners/workers.js';

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

  it('answers a command that cannot start with its error, and goes on to the next', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-driver-'));
    cleanups.push(dir);
    const driver = await startDriver({ scratch: dir, writable: [dir] });
    try {
      const missing = await driver.exec('perch-no-such-command', [], { cwd: dir });
      expect(missing).toMatchObject({ code: null, output: expect.stringContaining('ENOENT') });
      expect(await driver.exec('sh', ['-c', 'echo after'], { cwd: dir })).toMatchObject({ code: 0, output: 'after\n' });
    } finally { await driver.close(); }
  });

  it('stops a command still running when the session closes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-driver-'));
    cleanups.push(dir);
    const driver = await startDriver({ scratch: dir, writable: [dir] });
    const pidFile = join(dir, 'pid');
    const ran = driver.exec('sh', ['-c', `echo $$ > "${pidFile}"; exec sleep 30`], { cwd: dir });
    while (!existsSync(pidFile) || !(await readFile(pidFile, 'utf8')).trim()) await new Promise(resolve => setTimeout(resolve, 20));
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    const started = Date.now();
    await driver.close();
    await ran;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('keeps a worker between runs, and replaces one whose run left something going', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-workers-'));
    cleanups.push(dir);
    // Each run answers with the worker's process id; one asked to leaves a server listening, as a test whose request hung does.
    const script = `${WORKER_IO}
import { createServer } from 'node:net';
__perch_ready();
for await (const line of __perch_commands) {
  const { id, leave } = JSON.parse(line);
  if (leave) createServer().listen(0);
  await __perch_done({ id, pid: process.pid });
}
`;
    const workers = await startWorkers({ script, count: 1, scratch: dir, writable: [dir], cwd: dir });
    try {
      const first = await workers.run({ id: 1 });
      expect(first.left).toBe(false);
      expect((await workers.run({ id: 2 })).pid).toBe(first.pid);
      const dirty = await workers.run({ id: 3, leave: true });
      expect(dirty).toMatchObject({ pid: first.pid, left: true });
      expect((await workers.run({ id: 4 })).pid).not.toBe(first.pid);
    } finally { await workers.close(); }
  });

  it('says a worker would not start when it fails after it has begun waiting for commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-workers-'));
    cleanups.push(dir);
    // As a framework that fails while it loads, after an await: the command channel is already being read by then.
    const script = `${WORKER_IO}
await new Promise(done => setTimeout(done, 50));
throw new Error('the framework would not load');
`;
    await expect(startWorkers({ script, count: 1, scratch: dir, writable: [dir], cwd: dir })).rejects.toThrow(/would not start \(exit 1\).*the framework would not load/);
  }, 10000);

  it('starts its workers together', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-workers-'));
    cleanups.push(dir);
    // No worker is ready until all of them have started: started one at a time, the first would wait forever.
    const script = `${WORKER_IO}
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(process.env.PERCH_DIR + '/started-' + process.env.PERCH_INDEX, '');
while (![0, 1, 2].every(at => existsSync(process.env.PERCH_DIR + '/started-' + at))) await new Promise(done => setTimeout(done, 20));
__perch_ready();
for await (const line of __perch_commands) await __perch_done({ id: JSON.parse(line).id });
`;
    const workers = await startWorkers({ script, count: 3, scratch: dir, writable: [dir], cwd: dir, env: index => ({ PERCH_DIR: dir, PERCH_INDEX: String(index) }) });
    try {
      expect(await Promise.all([1, 2, 3].map(id => workers.run({ id })))).toMatchObject([{ id: 1 }, { id: 2 }, { id: 3 }]);
    } finally { await workers.close(); }
  }, 10000);

  it('stops the workers that started when one will not, and says why that one would not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-workers-'));
    cleanups.push(dir);
    // Worker 1 fails once the others are ready, as a browser that will not open fails one Karma worker.
    const script = `${WORKER_IO}
import { existsSync, writeFileSync } from 'node:fs';
const file = at => process.env.PERCH_DIR + '/ready-' + at;
if (process.env.PERCH_INDEX === '1') {
  while (!existsSync(file(0)) || !existsSync(file(2))) await new Promise(done => setTimeout(done, 20));
  process.stderr.write('no browser\\n');
  process.exit(1);
}
__perch_ready();
writeFileSync(file(process.env.PERCH_INDEX), String(process.pid));
for await (const line of __perch_commands) await __perch_done({ id: JSON.parse(line).id });
`;
    await expect(startWorkers({ script, count: 3, scratch: dir, writable: [dir], cwd: dir, env: index => ({ PERCH_DIR: dir, PERCH_INDEX: String(index) }) }))
      .rejects.toThrow('a test worker would not start (exit 1): no browser');
    const pids = await Promise.all([0, 2].map(async at => Number(await readFile(join(dir, `ready-${at}`), 'utf8'))));
    // A killed process is gone once Node has collected it.
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (const deadline = Date.now() + 5000; pids.some(alive) && Date.now() < deadline;) await new Promise(done => setTimeout(done, 20));
    expect(pids.filter(alive)).toEqual([]);
  }, 10000);

});

describe('the pytest runner', () => {
  it('names a node by its test, and reads each test\'s lines out of coverage.py\'s data file', async () => {
    expect(testOf('tests/test_x.py::TestCart::TestInner::test_deep')).toBe('tests/test_x.py::TestCart.TestInner.test_deep');
    expect(testOf('tests/test_x.py::test_param[1-a::b]')).toBe('tests/test_x.py::test_param');
    const dir = await mkdtemp(join(tmpdir(), 'perch-coveragepy-'));
    cleanups.push(dir);
    const copy = join(dir, 'copy');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir, '.coverage'));
    db.exec('create table file (id integer primary key, path text); create table context (id integer primary key, context text);'
      + ' create table line_bits (file_id integer, context_id integer, numbits blob); create table arc (file_id integer, context_id integer, fromno integer, tono integer);');
    // The copy's file, absolute as coverage.py writes it, and one outside the copy, which is not the repository's.
    db.prepare('insert into file values (1, ?)').run(join(copy, 'shop/calc.py'));
    db.prepare('insert into file values (2, ?)').run('/usr/lib/python3/os.py');
    for (const [id, context] of [[1, ''], [2, 'tests/test_calc.py::test_small|run'], [3, 'tests/test_calc.py::TestBig::test_large[1]|run'], [4, 'tests/test_calc.py::TestBig::test_large[2]|setup']]) {
      db.prepare('insert into context values (?, ?)').run(id, context);
    }
    // Lines 1 and 7 at import, under no test, as bits; test_small's lines 2 and 4 as bits; test_large's cases' lines as arcs.
    const bits = lines => { const bytes = new Uint8Array(2); for (const line of lines) bytes[line >> 3] |= 1 << (line & 7); return bytes; };
    db.prepare('insert into line_bits values (1, 1, ?)').run(bits([1, 7]));
    db.prepare('insert into line_bits values (1, 2, ?)').run(bits([2, 4]));
    db.prepare('insert into line_bits values (2, 2, ?)').run(bits([9]));
    for (const [from, to] of [[-1, 2], [2, 3], [3, -1]]) db.prepare('insert into arc values (1, 3, ?, ?)').run(from, to);
    db.prepare('insert into arc values (1, 4, ?, ?)').run(5, 6);
    db.close();
    const executed = await executedBy(join(dir, '.coverage'), copy);
    expect([...executed].map(([test, files]) => [test, [...files].map(([path, lines]) => [path, [...lines].sort((a, b) => a - b)])]).sort()).toEqual([
      ['tests/test_calc.py::TestBig.test_large', [['shop/calc.py', [2, 3, 5, 6]]]],
      ['tests/test_calc.py::test_small', [['shop/calc.py', [2, 4]]]],
    ]);
  });
});
