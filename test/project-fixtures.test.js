/**
 * perch coverage on projects laid out the way real ones are: test/fixtures/projects/<name>/, with the reports their own test run
 * wrote. What each expected.json says was read off the project; what perch makes of it must agree.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeFiles, createSourceAnalyzer, sourceFile } from '../src/analysis.js';
import { crateOf } from '../src/analyze.js';
import { buildGraph } from '../src/graph.js';
import { computeCoverage } from '../src/coverage.js';
import { frameworkScope } from '../src/test-scope.js';

const projects = fileURLToPath(new URL('./fixtures/projects/', import.meta.url));
const SKIPPED = new Set(['node_modules', 'target', 'build', 'dist', 'out', '.git', '.perch', 'reports', '.venv', '__pycache__', '.pytest_cache']);

/** Every file of the project, as a repository's tracked paths are. */
async function tracked(root, prefix = '') {
  const paths = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...await tracked(root, path));
    else paths.push(path);
  }
  return paths;
}

const named = existsSync(projects) ? (await readdir(projects, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : [];
const all = [];
for (const name of named) {
  const text = await readFile(join(projects, name, 'expected.json'), 'utf8').catch(() => null);
  if (text) all.push({ name, ...JSON.parse(text) });
}

/** The project read as a coverage run reads it: parsed, its graph built, its scope found. */
async function read(project) {
  const root = join(projects, project.name);
  const paths = await tracked(root);
  const scan = await analyzeFiles(paths.filter(path => sourceFile({ type: 'blob', path })).map(path => ({ type: 'blob', path })),
    { analyzer: createSourceAnalyzer(), readSource: file => readFile(join(root, file.path), 'utf8') });
  const crates = [];
  for (const path of paths.filter(path => /(^|\/)Cargo\.toml$/.test(path))) {
    const crate = crateOf(path, await readFile(join(root, path), 'utf8'));
    if (crate) crates.push(crate);
  }
  const graph = buildGraph(scan.files, { crates });
  // The fixtures are not installed, so a JavaScript config does not load here and the tests the parser found stand in for it.
  const scope = await frameworkScope({ root, tree: paths.map(path => ({ type: 'blob', path })), scan, graph });
  const coverage = computeCoverage({ scan, graph, inScope: path => !scope || scope.source(path), runs: path => !scope || scope.test(path), named: () => true });
  return { scope, coverage };
}

describe('project fixtures', () => {
  it('has a project for every supported framework', () => {
    expect(all.map(project => `${project.language} ${project.framework}`).sort()).toEqual([
      'cpp Catch2', 'cpp GoogleTest', 'cpp doctest', 'java JUnit 4', 'java JUnit 5', 'java TestNG', 'javascript Mocha', 'javascript node:test',
      'lua busted', 'lua luaunit', 'php PHPUnit', 'php Pest', 'python pytest', 'python unittest', 'ruby Minitest', 'ruby RSpec',
      'rust libtest', 'rust nextest', 'typescript Jest', 'typescript Vitest',
    ]);
  });

  describe.each(all.map(project => [project.name, project]))('%s', (_, project) => {
    let read$;
    const once = () => (read$ ??= read(project));

    it('leaves out the files no test framework covers', async () => {
      const { scope } = await once();
      for (const path of project.left_out) expect(scope.source(path) || scope.test(path), `${path} is left out`).toBe(false);
    }, 60000);

    it('finds each test and what it reaches', async () => {
      const { coverage } = await once();
      for (const want of project.tests) {
        const test = coverage.tests.find(item => item.node.path === want.file && item.node.case.name === want.name);
        const at = `${want.file} ${want.name}`;
        expect(test, `${at} is found`).toBeDefined();
        expect(test.reach.map(item => item.id), `${at} reaches`).toEqual(expect.arrayContaining(want.reaches));
      }
    }, 60000);
  });
});
