/**
 * JavaScript and TypeScript fixtures: Vitest with V8 coverage, Jest with Istanbul, Mocha with c8, and node:test with its own
 * coverage. Each application's own configuration names its JUnit reporter and that reporter's options, since those are what
 * perch needs of a real project; the generator only says where the files go. npm installs into the temporary copy.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { report, run, testEnv, works } from './common.mjs';

function npmMissing() {
  return works('npm', ['--version']) ? [] : ['npm'];
}

const install = copy => run('npm', ['install', '--no-audit', '--no-fund'], { cwd: copy.real, env: process.env });
const bin = (copy, name) => join(copy.real, 'node_modules/.bin', name);

/**
 * Vitest has no per-test coverage, so these write JUnit, LCOV and Cobertura for the whole run. Vitest writes no coverage
 * when a test fails unless told to, and these fixtures have failing tests, hence --coverage.reportOnFailure.
 */
async function vitest(copy) {
  install(copy);
  const { version } = JSON.parse(await readFile(join(copy.real, 'node_modules/vitest/package.json'), 'utf8'));
  run('npm', ['install', '--no-save', '--no-audit', '--no-fund', `@vitest/coverage-v8@${version}`], { cwd: copy.real, env: process.env });
  const junit = join(copy.out, 'junit.xml'), coverage = join(copy.out, 'coverage');
  run(bin(copy, 'vitest'), ['run', '--reporter=junit', `--outputFile=${junit}`, '--coverage.enabled', '--coverage.provider=v8',
    '--coverage.reporter=lcov', '--coverage.reporter=cobertura', '--coverage.reportOnFailure',
    `--coverage.reportsDirectory=${coverage}`], { cwd: copy.real, tests: true });
  return {
    'vitest/junit.xml': await report(copy, junit),
    'vitest/lcov.info': await report(copy, join(coverage, 'lcov.info')),
    'vitest/cobertura.xml': await report(copy, join(coverage, 'cobertura-coverage.xml')),
  };
}

/**
 * Jest with ts-jest and its default Istanbul coverage. The application's package.json lists jest-junit as a reporter and
 * configures it; JEST_JUNIT_OUTPUT_FILE, which jest-junit documents, only says where it writes.
 */
async function jest(copy) {
  install(copy);
  const junit = join(copy.out, 'junit.xml'), coverage = join(copy.out, 'coverage');
  run(bin(copy, 'jest'), ['--coverage', '--coverageReporters=lcov', '--coverageReporters=cobertura', `--coverageDirectory=${coverage}`],
    { cwd: copy.real, tests: true, env: { ...testEnv, JEST_JUNIT_OUTPUT_FILE: junit } });
  return {
    'jest/junit.xml': await report(copy, junit),
    'jest/lcov.info': await report(copy, join(coverage, 'lcov.info')),
    'jest/cobertura.xml': await report(copy, join(coverage, 'cobertura-coverage.xml')),
  };
}

/**
 * Mocha through ts-node, under c8. The application's .mocharc.json names mocha-junit-reporter and its options, and its .c8rc.json
 * the coverage reports; MOCHA_FILE, which mocha-junit-reporter documents, and c8's --report-dir only say where they go.
 */
async function mocha(copy) {
  install(copy);
  const junit = join(copy.out, 'junit.xml'), coverage = join(copy.out, 'coverage');
  run(bin(copy, 'c8'), [`--report-dir=${coverage}`, bin(copy, 'mocha')], { cwd: copy.real, tests: true, env: { ...testEnv, MOCHA_FILE: junit } });
  return {
    'mocha/junit.xml': await report(copy, junit),
    'mocha/lcov.info': await report(copy, join(coverage, 'lcov.info')),
    'mocha/cobertura.xml': await report(copy, join(coverage, 'cobertura-coverage.xml')),
  };
}

/**
 * node:test running the TypeScript as Node strips its types, with Node's own junit and lcov reporters and its own coverage,
 * which is still behind --experimental-test-coverage. The stub test mocks a module, which Node puts behind
 * --experimental-test-module-mocks. Nothing is installed: Node runs the tests alone.
 */
async function nodeTest(copy) {
  const junit = join(copy.out, 'junit.xml'), lcov = join(copy.out, 'lcov.info');
  run(process.execPath, ['--test', '--experimental-test-module-mocks', '--experimental-test-coverage', '--test-coverage-include=src/**',
    '--test-reporter=junit', `--test-reporter-destination=${junit}`, '--test-reporter=lcov', `--test-reporter-destination=${lcov}`,
    'test/*.test.ts'], { cwd: copy.real, tests: true });
  return { 'node-test/junit.xml': await report(copy, junit), 'node-test/lcov.info': await report(copy, lcov) };
}

export const apps = {
  'order-service-typescript': { missing: npmMissing, generate: vitest },
  'order-service-frontend': { missing: npmMissing, generate: vitest },
  'order-service-jest': { missing: npmMissing, generate: jest },
  'order-service-frontend-jest': { missing: npmMissing, generate: jest },
  'order-service-mocha': { missing: npmMissing, generate: mocha },
  'order-service-node-test': { missing: () => [], generate: nodeTest },
};
