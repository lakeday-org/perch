import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { available, exec, executedBy, session, testOf } from '../src/runners/pytest.js';
import { sandboxKind } from '../src/runners/sandbox.js';
import { startDriver } from '../src/runners/driver.js';
import { startWorkers, WORKER_IO } from '../src/runners/workers.js';

const cleanups = [];
const pytest = await available({ root: tmpdir() });
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

  it.skipIf(!pytest.python)('finds the mutated code without touching lazily loaded modules or objects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-lazy-'));
    cleanups.push(dir);
    const copy = { dir: join(dir, 'copy'), scratch: join(dir, 'scratch') };
    await mkdir(join(copy.dir, 'shop'), { recursive: true });
    await mkdir(join(copy.dir, 'tests'));
    await mkdir(copy.scratch);
    await writeFile(join(copy.dir, 'shop', '__init__.py'), '');
    await writeFile(join(copy.dir, 'shop', 'calc.py'), 'def add(a, b):\n    return a + b\n');
    await writeFile(join(copy.dir, 'tests', 'test_calc.py'), 'from shop.calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n');
    // A module in sys.modules and an object in memory that import on any attribute they lack, as a PEP 562 `__getattr__` or a
    // six.moves-style proxy does, and fail to: prefect's lazy tkinter import did this in an image without libtk.
    await writeFile(join(copy.dir, 'conftest.py'), [
      'import sys', 'import types', '', '',
      'def missing(name):', "    raise ImportError('libtk8.6.so: cannot open shared object file')", '', '',
      "lazy = types.ModuleType('lazy_tk')", 'lazy.__getattr__ = missing', "sys.modules['lazy_tk'] = lazy", '', '',
      'class LazyProxy:', '    def __getattr__(self, name):', '        missing(name)', '', '',
      'PROXY = LazyProxy()', '',
    ].join('\n'));
    await writeFile(join(copy.dir, 'pytest.ini'), '[pytest]\ntestpaths = tests\n');
    const server = await session({ copies: [copy], tool: pytest, parallel: 1 });
    try {
      const result = await server.run({ path: 'shop/calc.py', source: Buffer.from('def add(a, b):\n    return a - b\n'), method: { node: { qualified_name: 'add', line: 1 } },
        mutant: { statements: [2] }, nodes: ['tests/test_calc.py::test_add'], timeout: 30000 });
      expect(result.status).toBe('ran');
      expect([...result.results.values()]).toEqual([{ test: 'tests/test_calc.py::test_add', status: 'failed' }]);
    } finally { await server.close(); }
  }, 60000);
});
