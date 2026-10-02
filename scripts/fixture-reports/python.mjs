/** Python fixtures: pytest with pytest-cov, and unittest with unittest-xml-reporting under coverage.py. */
import { join } from 'node:path';
import { python, report, run, testEnv, works } from './common.mjs';

// coverage.py's sys.monitoring core, the default on Python 3.12 and later, stops watching a line once it has run, so with
// per-test contexts each line was credited to the first test that ran it and to no other. The tracing core records every test
// that runs a line.
const tracing = { ...testEnv, COVERAGE_CORE: 'ctrace' };

/** coverage.py's JSON with the context of every line, and its LCOV, from the data the test run left in the copy. */
async function coverageReports(copy, runner) {
  run(python, ['-m', 'coverage', 'json', '--show-contexts', '-o', join(copy.out, 'coverage.json')], { cwd: copy.real });
  run(python, ['-m', 'coverage', 'lcov', '-o', join(copy.out, 'lcov.info')], { cwd: copy.real });
  return {
    [`${runner}/coverage.json`]: await report(copy, join(copy.out, 'coverage.json')),
    [`${runner}/lcov.info`]: await report(copy, join(copy.out, 'lcov.info')),
  };
}

export const apps = {
  'order-service': {
    missing() {
      return works(python, ['-c', 'import pytest, pytest_cov, coverage']) ? [] : [`${python} with pytest, pytest-cov and coverage (set PERCH_FIXTURE_PYTHON)`];
    },
    async generate(copy) {
      const junit = join(copy.out, 'junit.xml');
      run(python, ['-m', 'pytest', `--junitxml=${junit}`, '--cov=.', '--cov-branch', '--cov-context=test'], { cwd: copy.real, tests: true, env: tracing });
      return { 'pytest/junit.xml': await report(copy, junit), ...await coverageReports(copy, 'pytest') };
    },
  },
  'order-service-unittest': {
    missing() {
      return works(python, ['-c', 'import xmlrunner, coverage']) ? [] : [`${python} with unittest-xml-reporting and coverage (set PERCH_FIXTURE_PYTHON)`];
    },
    // Branch coverage and the per-test `test_function` context are the application's own coverage configuration, in its
    // pyproject.toml. Discovery runs from the application root, so each test's module is its path from there.
    async generate(copy) {
      const junit = join(copy.out, 'junit.xml');
      run(python, ['-m', 'coverage', 'run', '-m', 'xmlrunner', '--output-file', junit, 'discover', '-s', 'tests', '-t', '.'],
        { cwd: copy.real, tests: true, env: tracing });
      return { 'unittest/junit.xml': await report(copy, junit), ...await coverageReports(copy, 'unittest') };
    },
  },
};
