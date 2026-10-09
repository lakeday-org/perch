/**
 * The test frameworks perch runs. A runner says whether it can run here, runs the whole suite once with per-test coverage, and
 * runs a set of tests against the copy as it stands. Its suite run returns `executed`, the lines each test ran by file, keyed by
 * perch's test id, and `results`, each case it ran by the runner's own id, with its test, status and time.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import * as pytest from './pytest.js';
import { javascriptRunner } from './javascript.js';
import * as cargo from './cargo.js';
import * as go from './go.js';
import * as dotnet from './dotnet.js';
import * as jvm from './jvm.js';

const run = promisify(execFile);

/**
 * The runners for the repository's test frameworks, by what frameworkScope found and what the root package depends on: pytest for
 * Python tests; Vitest or Jest where their config loaded; otherwise Mocha where the package depends on it, or node:test where
 * the tests import it. More than one is one runner over all of them.
 */
export async function runnersFor({ scope, root, graph }) {
  // A framework counts the test files it runs.
  const names = new Set((scope?.frameworks ?? []).filter(framework => (Array.isArray(framework.tests) ? framework.tests.length : framework.tests ?? 0) > 0).map(framework => framework.name));
  const found = [];
  if (names.has('pytest')) found.push(pytest);
  if (names.has('Vitest')) found.push(javascriptRunner('vitest'));
  else if (names.has('Jest')) found.push(javascriptRunner('jest'));
  else if (names.has('JavaScript tests')) {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8').catch(() => '{}'));
    const depends = name => Boolean(manifest.devDependencies?.[name] ?? manifest.dependencies?.[name]);
    const frameworks = new Set([...graph.nodes.values()].filter(node => node.case).map(node => node.case.framework));
    if (depends('mocha')) found.push(javascriptRunner('mocha'));
    else if (depends('jasmine')) found.push(javascriptRunner('jasmine'));
    else if (depends('vitest')) found.push(javascriptRunner('vitest'));
    else if (depends('jest')) found.push(javascriptRunner('jest'));
    else if (frameworks.has('node:test')) found.push(javascriptRunner('node:test'));
  }
  // A compiled language's tests are found by the parser; its build tool runs them.
  const tested = new Set([...graph.nodes.values()].filter(node => node.case).map(node => graph.files.get(node.path)?.file.language));
  if (tested.has('rust')) found.push(cargo);
  if (tested.has('go')) found.push(go);
  if (tested.has('csharp') || tested.has('c_sharp')) found.push(dotnet);
  if (tested.has('java') || tested.has('kotlin') || tested.has('scala')) found.push(jvm);
  return found.length ? combined(found) : null;
}

/**
 * Several runners as one: each prepares the copy for its own languages and runs its own tests once, the runs' results are put
 * together, and each mutant goes to the runner of its language.
 */
export function combined(runners) {
  if (runners.length === 1) return runners[0];
  const owner = language => runners.find(runner => runner.languages.has(language));
  return {
    name: runners.map(runner => runner.name).join(' and '),
    languages: new Set(runners.flatMap(runner => [...runner.languages])),
    copiesFor: parallel => Math.max(...runners.map(runner => runner.copiesFor(parallel))),
    async available(args) {
      const tools = [];
      for (const runner of runners) {
        const tool = await runner.available(args);
        if (tool.reason) return { reason: `${runner.name}: ${tool.reason}` };
        tools.push(tool);
      }
      return { tools };
    },
    async prepare({ generated, graph, tool, ...rest }) {
      for (const [at, runner] of runners.entries()) {
        const own = new Map([...generated].filter(([methodId]) => runner.languages.has(graph.files.get(graph.nodes.get(methodId).path)?.file.language)));
        await runner.prepare?.({ ...rest, generated: own, graph, tool: tool.tools[at] });
      }
    },
    async coverageRun({ tool, ...rest }) {
      const merged = { executed: new Map(), results: new Map(), hits: null, hitMethods: new Set(), unplaced: new Set(), seconds: 0 };
      for (const [at, runner] of runners.entries()) {
        const base = await runner.coverageRun({ ...rest, tool: tool.tools[at] });
        for (const [test, files] of base.executed) merged.executed.set(test, files);
        for (const [node, result] of base.results) merged.results.set(node, result);
        if (base.hits) { merged.hits ??= new Map(); for (const [test, keys] of base.hits) merged.hits.set(test, keys); }
        for (const id of base.hitMethods ?? []) merged.hitMethods.add(id);
        for (const key of base.unplaced ?? []) merged.unplaced.add(key);
        merged.seconds += base.seconds;
      }
      return merged;
    },
    async session({ tool, ...rest }) {
      const sessions = new Map();
      for (const [at, runner] of runners.entries()) sessions.set(runner, await runner.session({ ...rest, tool: tool.tools[at] }));
      return {
        run: args => sessions.get(owner(args.language)).run(args),
        close: async () => { for (const session of sessions.values()) await session.close(); },
      };
    },
  };
}

/**
 * Copies of the repository at `revision`, one per worker, under one scratch directory: `git archive` writes the committed tree,
 * which is what the mutants are made from, so an edit in the working tree can neither break a mutant's offset nor be mutated.
 */
export async function copiesOf({ root, revision, count }) {
  // Resolved, as the tools that run in it write paths: macOS's temporary directory is a symlink, and coverage.py records the target.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'perch-mutants-')));
  const copies = [];
  for (let at = 0; at < count; at++) {
    const dir = join(scratch, `copy-${at}`);
    await mkdir(dir);
    await run('sh', ['-c', 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', 'sh', root, revision, dir], { maxBuffer: 1 << 20 });
    copies.push({ dir, scratch: await mkdtemp(join(scratch, `work-${at}-`)) });
  }
  return { scratch, copies, remove: () => rm(scratch, { recursive: true, force: true }) };
}
