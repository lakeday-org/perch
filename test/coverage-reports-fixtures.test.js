/**
 * perch coverage reading what a real test run wrote: the JUnit XML and coverage reports generated from each fixture application
 * by its own framework and coverage tool. They are kept under test/fixtures/<app>/reports/<runner>/, one directory per way of
 * running the same tests: pytest, Vitest, libtest and nextest, Maven and Gradle. For every set, each of the application's twelve
 * tests (test/fixtures/<app>/expected.json) must have a run matched to it, and nothing in the reports may go unmatched. Reports are
 * committed, so an application with none fails here rather than being passed over.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectations } from './fixtures/expectations.mjs';
import { analyzeFiles, createSourceAnalyzer, sourceFile } from '../src/analysis.js';
import { buildGraph } from '../src/graph.js';
import { computeCoverage, readReports } from '../src/coverage.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const expected = await expectations();
/** The report files a fixture's run writes, by the kind perch reads each as. A `junit/` directory holds one file per class. */
const KINDS = { 'junit.xml': 'junit', 'lcov.info': 'lcov', 'cobertura.xml': 'cobertura', 'coverage.json': 'contexts', 'jacoco.xml': 'jacoco' };
const SKIPPED = new Set(['node_modules', 'dist', 'target', 'out', '.git', '.perch', 'reports']);

/** Every file of the application, as a repository's tracked paths are: what a report's paths must be one of. */
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

/** Every report set of every application: `[app, runner, files]`. */
async function reportSets() {
  const sets = [];
  for (const app of expected) {
    const dir = join(fixtures, app.app, 'reports');
    if (!existsSync(dir)) { sets.push([app, null, []]); continue; }
    for (const runner of (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
      const files = [];
      for (const entry of await readdir(join(dir, runner), { withFileTypes: true })) {
        if (entry.isFile() && KINDS[entry.name]) files.push({ kind: KINDS[entry.name], path: join(dir, runner, entry.name) });
        if (entry.isDirectory() && entry.name === 'junit') {
          for (const name of (await readdir(join(dir, runner, 'junit'))).filter(name => name.endsWith('.xml')).sort()) files.push({ kind: 'junit', path: join(dir, runner, 'junit', name) });
        }
      }
      sets.push([app, runner, files.sort((a, b) => a.path.localeCompare(b.path))]);
    }
  }
  return sets;
}
const sets = await reportSets();

describe('fixture test reports', () => {
  it.each(sets.map(([app, runner, files]) => [app.app, runner ?? 'no reports', app, files]))('%s with %s', async (_, runner, app, files) => {
    expect(runner, `${app.app} has no reports under test/fixtures/${app.app}/reports/<runner>/`).not.toBe('no reports');
    const root = join(fixtures, app.app);
    const paths = await tracked(root);
    const scan = await analyzeFiles(paths.filter(path => sourceFile({ type: 'blob', path })).map(path => ({ type: 'blob', path })),
      { analyzer: createSourceAnalyzer(), readSource: file => readFile(join(root, file.path), 'utf8') });
    expect(files.map(file => file.kind), `${app.app} ${runner}: a JUnit report`).toContain('junit');
    const reports = await readReports({ root, files, paths: new Set(paths) });
    const coverage = computeCoverage({ scan, graph: buildGraph(scan.files), reports });
    expect(coverage.measurement.unmatched_runs, `${app.app} ${runner}: unmatched runs`).toEqual([]);
    expect(coverage.measurement.unmatched_paths, `${app.app} ${runner}: unmatched paths`).toEqual([]);
    expect(coverage.tests).toHaveLength(app.tests.length);
    for (const want of app.tests) {
      const test = coverage.tests.find(item => item.node.path === want.file && item.node.case.name === want.name);
      const at = `${app.app} ${runner} #${want.n} ${want.name}`;
      expect(test, at).toBeDefined();
      expect(test.run, `${at}: run`).not.toBe(null);
      expect(test.run.cases, `${at}: cases`).toBe(1);
      expect(typeof test.run.time, `${at}: time`).toBe('number');
    }
    // The suite is every run the JUnit reports hold, each matched to one test.
    expect(coverage.measurement.suite.runs).toBe(app.tests.length);
    // A coverage report was read, and measured something.
    expect(files.some(file => file.kind !== 'junit'), `${app.app} ${runner}: a coverage report`).toBe(true);
    expect(coverage.methods.some(method => method.measured), `${app.app} ${runner}: measured methods`).toBe(true);
  });
});
