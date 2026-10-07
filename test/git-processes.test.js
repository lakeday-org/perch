import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// The git processes perch has open, and the most it had at once. Each one holds three pipes in perch's own process, so starting
// one per caller ran a scan out of open files on a method called from a few hundred places.
const processes = vi.hoisted(() => ({ open: 0, most: 0 }));
vi.mock('node:child_process', async original => {
  const child = await original();
  const { promisify } = await import('node:util');
  const track = started => {
    processes.open++; processes.most = Math.max(processes.most, processes.open);
    started.once('close', () => { processes.open--; });
    return started;
  };
  const execFile = (...args) => track(child.execFile(...args));
  execFile[promisify.custom] = (...args) => { const running = child.execFile[promisify.custom](...args); track(running.child); return running; };
  return { ...child, spawn: (...args) => track(child.spawn(...args)), execFile };
});

const { revision } = await import('../src/git.js');
const { analyzeTree } = await import('../src/analyze.js');
const { createSourceAnalyzer } = await import('../src/analysis.js');
const { createLineReader, methodContext } = await import('../src/context.js');
const { buildGraph } = await import('../src/graph.js');
const { scanRepository } = await import('../src/scan.js');
const { fixtureOptions, initRepo, scriptedSystemOne } = await import('./helpers.js');

const analyzer = createSourceAnalyzer();
const CALLERS = 300;
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** One function and CALLERS functions that call it, either all in one file or one to a file. */
async function manyCallers(layout) {
  const root = await mkdtemp(join(tmpdir(), 'perch-callers-'));
  cleanups.push(root);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'target.js'), 'export function target(x) {\n  return x + 1;\n}\n');
  const imports = "import { target } from './target.js';\n\n";
  const caller = index => `export function caller${index}(x) {\n  return target(x) * ${index};\n}\n`;
  if (layout === 'one file') await writeFile(join(root, 'src', 'callers.js'), imports + Array.from({ length: CALLERS }, (_, index) => caller(index)).join('\n'));
  else for (let index = 0; index < CALLERS; index++) await writeFile(join(root, 'src', `caller${index}.js`), imports + caller(index));
  await initRepo(root);
  return { root, revision: await revision(root), out: join(root, '.perch') };
}

it.each(['one file', 'a file each'])('reads a method whose callers are in %s through one git process', async layout => {
  const repo = await manyCallers(layout);
  processes.most = processes.open;
  const systemOne = scriptedSystemOne();
  const run = await scanRepository(fixtureOptions(repo, { analyzer, paths: ['src/target.js'], systemOne }));
  expect(run.failed).toEqual([]);
  expect(run.visited[0].callers).toHaveLength(CALLERS);
  // The reader, and the one before it while git exits.
  expect(processes.most).toBeLessThanOrEqual(2);

  // perch check reads the same neighbourhood.
  processes.most = processes.open;
  const context = await methodContext({ finding: { method: 'src/target.js::target', revision: repo.revision }, root: repo.root, out: repo.out, analyzer });
  expect(context.callers).toHaveLength(CALLERS);
  expect(processes.most).toBeLessThanOrEqual(2);
});

it('reads a file once however many of its methods ask for it at once', async () => {
  const repo = await manyCallers('one file');
  const graph = buildGraph((await analyzeTree({ root: repo.root, revision: repo.revision, out: repo.out, analyzer })).files);
  const linesOf = createLineReader(repo.root, graph);
  try {
    const callers = [...graph.nodes.values()].filter(node => node.path === 'src/callers.js');
    expect(callers).toHaveLength(CALLERS);
    expect(new Set(await Promise.all(callers.map(linesOf))).size).toBe(1);
  } finally { linesOf.close(); }
});
