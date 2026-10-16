/**
 * Rust fixtures: the same tests run by libtest and by cargo-nextest, each under cargo-llvm-cov.
 *
 * libtest writes reports/libtest/: its own JUnit and an LCOV with one TN record per test, assembled as scripts/fixture-reports.mjs
 * says. cargo-nextest writes reports/nextest/: the JUnit the fixture's .config/nextest.toml asks for under its `ci` profile, and
 * the LCOV `cargo llvm-cov nextest` writes for the whole run.
 */
import { join } from 'node:path';
import { relative, report, run, toolchain, works } from './common.mjs';

export const apps = {
  'order-service-rust': {
    missing() {
      const missing = [];
      if (!works('cargo', [toolchain, '--version'])) missing.push(`cargo ${toolchain}`);
      if (!works('cargo', ['llvm-cov', '--version'])) missing.push('cargo-llvm-cov');
      if (!works('cargo', ['nextest', '--version'])) missing.push('cargo-nextest');
      return missing;
    },
    async generate(copy) {
      const junit = run('cargo', [toolchain, 'test', '--', '-Z', 'unstable-options', '--format', 'junit', '--report-time'], { cwd: copy.real, tests: true }).stdout;
      if (junit.split('<?xml').length !== 2) throw new Error('cargo test wrote other than one JUnit document; this fixture has one test binary');
      const listed = run('cargo', [toolchain, 'test', '--', '--list', '--format', 'terse'], { cwd: copy.real }).stdout;
      const names = listed.split('\n').filter(line => line.endsWith(': test')).map(line => line.slice(0, -': test'.length));
      const tns = new Map();
      for (const name of names) {
        const tn = name.split('::').join('__');
        if (!/^[A-Za-z0-9_]+$/.test(tn)) throw new Error(`${name} makes TN ${tn}, which LCOV does not allow`);
        if (tns.has(tn)) throw new Error(`${name} and ${tns.get(tn)} both make TN ${tn}`);
        tns.set(tn, name);
      }
      const traces = [];
      for (const [tn, name] of tns) {
        const file = join(copy.out, `${tn}.info`);
        run('cargo', [toolchain, 'llvm-cov', '--branch', '--lcov', '--output-path', file, '--ignore-run-fail', '--', name, '--exact'], { cwd: copy.real, tests: true });
        const trace = await report(copy, file);
        if (/^TN:/m.test(trace)) throw new Error(`${file} already has TN records`);
        traces.push(trace.replace(/^SF:/gm, `TN:${tn}\nSF:`).replace(/\n?$/, '\n'));
      }
      const lcov = join(copy.out, 'nextest.info');
      run('cargo', [toolchain, 'llvm-cov', 'nextest', '--branch', '--lcov', '--output-path', lcov, '--ignore-run-fail', '--profile', 'ci'], { cwd: copy.real, tests: true });
      return {
        'libtest/junit.xml': relative(junit, copy),
        'libtest/lcov.info': traces.join(''),
        'nextest/junit.xml': await report(copy, join(copy.real, 'target/nextest/ci/junit.xml')),
        'nextest/lcov.info': await report(copy, lcov),
      };
    },
  },
};
