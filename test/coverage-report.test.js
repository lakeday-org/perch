import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { coverageCount, coverageDetails, duration, formatCoverage, formatCoverageDiff, listedFindings, parseCoverageFilters } from '../src/coverage-report.js';

/**
 * A report written out by hand, in the shape the contract gives it, so the formatting is checked against numbers chosen here rather
 * than numbers the engine happened to produce. Two source files, one test file, and findings of three kinds.
 */
const totalsOf = values => ({ methods: 0, reached: 0, useful_reached: 0, exercised: null, exercised_basis: null, measured: null, tests: 0, useful: 0, redundant: 0,
  smelly: 0, infra: 0, seconds: null, timed: 0, ...values });
const report = {
  version: 1, revision: '9f8e7d6c5b4a', root: '/repo', created_at: '2026-09-28T10:00:00.000Z', model: 'jev-1', depth: 3, min: 50,
  totals: { methods: 6, reached: 4, useful_reached: 4, exercised: 0.54, exercised_basis: 'estimated', measured: { lines: { hit: 30, total: 40 }, branches: { hit: 5, total: 12 } },
    effective: { lines: { hit: 24, total: 40, basis: 'measured' }, branches: { hit: 3, total: 12, basis: 'estimated' } },
    tests: 5, useful: 3, redundant: 1, smelly: 1, infra: 0, seconds: 2.5, timed: 5, dropped_seconds: 1.25,
    untested: 2, edge_cases: 1, cost: { 0: 3, 1: 2, 2: 0, 3: 0 }, drop: { count: 2, cost: { 0: 1, 1: 0, 2: 0, 3: 1 }, unreached: [], seconds: null, timed: 0 }, suite: null },
  files: [
    { path: 'src/tax.py', kind: 'source', language: 'python', lines: [], methods: ['m4', 'm5', 'm6'], tests: [],
      totals: totalsOf({ methods: 3, reached: 1, useful_reached: 1, exercised: null }) },
    { path: 'src/cart.py', kind: 'source', language: 'python', lines: [], methods: ['m1', 'm2', 'm3'], tests: [],
      totals: totalsOf({ methods: 3, reached: 3, useful_reached: 3, exercised: 0.41, exercised_basis: 'measured', measured: { lines: { hit: 30, total: 40 }, branches: { hit: 5, total: 12 } },
        effective: { lines: { hit: 24, total: 40, basis: 'measured' }, branches: { hit: 3, total: 12, basis: 'estimated' } } }) },
    { path: 'tests/test_cart.py', kind: 'test', language: 'python', lines: [], methods: [], tests: ['t1', 't2', 't3', 't4', 't5'],
      totals: totalsOf({ tests: 5, useful: 3, redundant: 1, smelly: 1, infra: 0, seconds: 2.5, timed: 5, dropped_seconds: 1.25 }) },
  ],
  methods: [],
  tests: [
    { id: 't1', path: 'tests/test_cart.py' },
    { id: 't2', path: 'tests/test_cart.py' },
  ],
  findings: [
    { id: 'a91c2e0f', kind: 'redundant', subject: 'test', unit: 't2', path: 'tests/test_cart.py', line: 41, name: 'test_discount_20',
      probability: 0.88, note: 'Decides happy_path of apply_discount, like test_discount_10 at line 12.' },
    { id: 'b7d31e22', kind: 'untested', subject: 'method', unit: 'm5', path: 'src/tax.py', line: 30, name: 'round_tax',
      probability: null, note: 'No test reaches round_tax.' },
    { id: 'c0ffee11', kind: 'untested', subject: 'method', unit: 'm6', path: 'src/tax.py', line: 9, name: 'rate_for',
      probability: null, note: 'No test reaches rate_for.' },
    { id: 'd4e5f6a7', kind: 'edge_case', subject: 'method', unit: 'm1', path: 'src/cart.py', line: 17, name: 'apply_discount',
      probability: 0.72, note: 'No test decides the boundary at line 17.' },
    // Under the floor, so it is on the report and off the list.
    { id: 'e1e2e3e4', kind: 'edge_case', subject: 'method', unit: 'm2', path: 'src/cart.py', line: 50, name: 'total',
      probability: 0.31, note: 'No test decides the empty cart at line 50.' },
  ],
  failed: [{ unit: 'm9', subject: 'method', path: 'src/tax.py', name: 'legacy', error: 'too long to send' }],
  baseline: { revision: '1a2b3c4d5e6f', created_at: '2026-09-20T10:00:00.000Z' },
  diff: {
    from: { revision: '1a2b3c4d5e6f', created_at: '2026-09-20T10:00:00.000Z' },
    to: { revision: '9f8e7d6c5b4a', created_at: '2026-09-28T10:00:00.000Z' },
    totals: { methods: { before: 6, after: 6 }, reached: { before: 4, after: 4 }, exercised: { before: 0.45, after: 0.54 },
      tests: { before: 3, after: 5 }, useful: { before: 2, after: 3 }, redundant: { before: 0, after: 1 }, smelly: { before: 1, after: 1 },
      infra: { before: 0, after: 0 }, untested: { before: 2, after: 2 }, edge_cases: { before: 2, after: 1 } },
    files: [
      { path: 'src/cart.py', before: totalsOf({ methods: 3, reached: 2, exercised: 0.3 }), after: totalsOf({ methods: 3, reached: 3, exercised: 0.41 }) },
      { path: 'tests/test_cart.py', before: totalsOf({ tests: 3, useful: 2, smelly: 1 }), after: totalsOf({ tests: 5, useful: 3, redundant: 1, smelly: 1 }) },
      { path: 'src/old.py', before: totalsOf({ methods: 1, reached: 1, exercised: 1 }), after: null },
    ],
    methods: [],
    tests: { added: ['t4', 't5'], removed: [] },
    findings: { fixed: [{}, {}, {}], new: [{}] },
  },
  usage: {},
};

const plain = { width: 160, color: false };
const rowOf = (text, start) => text.split('\n').find(line => line.startsWith(start));

describe('coverage report', () => {
  it('prints source and test tables with totals', () => {
    const text = formatCoverage(report, { min: 0.5, ...plain });
    const source = text.split('\n\n')[0].split('\n');
    expect(source[0]).toMatch(/^Source files\s+Methods tested\s+Lines\s+Branches\s+Effective lines\s+Effective branches\s+Untested branches$/);
    // Files in path order, whatever order the report had them in.
    expect(source.slice(1).map(line => line.split(/\s{2,}/)[0])).toEqual(['src/cart.py', 'src/tax.py', 'All source']);
    // cart.py was measured: 30 of its 40 lines ran and 5 of its 12 branches were taken, counted over all as the page counts them.
    // Tests worth keeping ran 24 of the lines, from per-test records, and an estimated 3 of the branches.
    expect(rowOf(text, 'src/cart.py').split(/\s{2,}/)).toEqual(['src/cart.py', '3 of 3', '75%', '42%', '60%', '25% est.', '1']);
    // Nothing measured or answered about tax.py, which is a dash and not a zero.
    expect(rowOf(text, 'src/tax.py').split(/\s{2,}/)).toEqual(['src/tax.py', '1 of 3', '-', '-', '-', '-', '0']);
    // The whole is what the report measured, lines and branches alike: tax.py was not in it.
    expect(rowOf(text, 'All source').split(/\s{2,}/)).toEqual(['All source', '4 of 6', '75%', '42%', '60%', '25% est.', '1']);
    // Quality is the tests worth keeping, of all of them; then why the rest are not, and what the tests touch.
    // Time saved is what the duplicate and weak tests took.
    expect(rowOf(text, 'Test files').split(/\s{2,}/)).toEqual(['Test files', 'Quality', 'Duplicates', 'Weak', 'Unmocked I/O', 'Time', 'Time saved']);
    expect(rowOf(text, 'tests/test_cart.py ').split(/\s{2,}/)).toEqual(['tests/test_cart.py', '60% (3 of 5)', '1', '1', '0', '2.5s', '1.3s']);
    expect(rowOf(text, 'All tests').split(/\s{2,}/)).toEqual(['All tests', '60% (3 of 5)', '1', '1', '0', '2.5s', '1.3s']);
  });

  it('groups problems above the floor by file', () => {
    const text = formatCoverage(report, { min: 0.5, ...plain });
    const blocks = text.split('\n\n').slice(2);
    expect(blocks.map(block => block.split('\n')[0])).toEqual(['src/cart.py', 'src/tax.py', 'tests/test_cart.py']);
    expect(blocks[0].split('\n')[1]).toMatch(/^ {2}ID\s+Line\s+Problem\s+Confidence\s+Test or method\s+Note$/);
    expect(blocks[0]).toContain('d4e5f6a7');
    expect(blocks[0]).not.toContain('e1e2e3e4');
    // Within a file, by line.
    expect(blocks[1].split('\n').slice(2).map(line => line.trim().split(/\s+/)[0])).toEqual(['c0ffee11', 'b7d31e22']);
    expect(rowOf(blocks[1], '  c0ffee11').split(/\s{2,}/).slice(1)).toEqual(['c0ffee11', '9', 'untested', '-', 'rate_for', 'No test reaches rate_for.']);
    expect(rowOf(blocks[2], '  a91c2e0f').split(/\s{2,}/).slice(1)).toEqual(['a91c2e0f', '41', 'redundant', '88%', 'test_discount_20',
      'Decides happy_path of apply_discount, like test_discount_10 at line 12.']);
    expect(listedFindings(report, { min: 0.5 }).map(finding => finding.id)).toEqual(['a91c2e0f', 'b7d31e22', 'c0ffee11', 'd4e5f6a7']);
    // --min 0 lists the one under the floor as well.
    expect(formatCoverage(report, { min: 0, ...plain })).toContain('e1e2e3e4');
  });

  it('cuts long notes to the terminal width', () => {
    const text = formatCoverage(report, { min: 0.5, width: 70, color: false });
    const row = rowOf(text, '  a91c2e0f');
    expect(row.length).toBeLessThanOrEqual(70);
    expect(row.endsWith('…')).toBe(true);
  });

  it('filters problems by kind', () => {
    const filters = parseCoverageFilters('kind=untested');
    expect(filters).toEqual([{ key: 'kind', value: 'untested' }]);
    const text = formatCoverage(report, { min: 0.5, filters, ...plain });
    expect(text).toContain('c0ffee11');
    expect(text).toContain('b7d31e22');
    expect(text).not.toContain('a91c2e0f');
    expect(text).not.toContain('d4e5f6a7');
    expect(rowOf(text, 'src/cart.py').split(/\s{2,}/)).toEqual(['src/cart.py', '3 of 3', '75%', '42%', '60%', '25% est.', '1']);
    // A second value is another alternative for the same key, and a spelling with a space or a hyphen is the same kind.
    expect(parseCoverageFilters('kind=edge case,redundant')).toEqual([{ key: 'kind', value: 'edge_case' }, { key: 'kind', value: 'redundant' }]);
    expect(() => parseCoverageFilters('kind=bogus')).toThrow(/kind "bogus" is not one of untested, edge_case, redundant/);
    expect(() => parseCoverageFilters('type=defect')).toThrow(/filters on kind, not "type"/);
  });

  it('ends with one count line, the way a scan does', () => {
    // Three problems over the floor, and one on a method that could not be asked, which no floor can judge.
    expect(coverageCount(report, { min: 0.5 })).toBe('/repo at commit 9f8e7d6: 6 methods, 5 tests, 4 problems, 1 could not be asked (--json)');
    const many = { ...report, failed: [], findings: Array.from({ length: 12 }, (_, at) => ({ ...report.findings[1], id: `f${at}`, unit: `m${at}` })) };
    expect(coverageCount(many, { min: 0.5 })).toBe('/repo at commit 9f8e7d6: 6 methods, 5 tests, 12 problems, 10 shown, --all for the rest');
    expect(coverageCount(many, { min: 0.5, all: true })).toBe('/repo at commit 9f8e7d6: 6 methods, 5 tests, 12 problems');
    const broken = { ...many, scope: { frameworks: [{ name: 'Jest', config: 'jest.config.js', error: 'no jest' }], left_out: 0 } };
    expect(coverageCount(broken, { min: 0.5, all: true })).toBe('/repo at commit 9f8e7d6: 6 methods, 5 tests, 12 problems, jest.config.js did not load (--verbose)');
  });

  it('keeps what matched nothing for --verbose', () => {
    const odd = { ...report, scope: { frameworks: [{ name: 'Vitest', version: '2.1.9', config: 'vitest.config.js', tests: 40 }, { name: 'Jest', config: 'jest.config.js', error: 'no jest' }], left_out: 3 },
      unmatched_runs: [{ path: 'reports/junit.xml', classname: 'tests.test_gone', name: 'test_old' }],
      unmatched_paths: [{ path: 'reports/lcov.info', reported: '/build/gen/parser.py' }] };
    expect(coverageDetails(odd)).toEqual([
      '3 files no test framework covers left out',
      'unmatched run in reports/junit.xml: tests.test_gone test_old',
      'unmatched path in reports/lcov.info: /build/gen/parser.py',
    ]);
    expect([duration(0.004), duration(0.5), duration(41.24), duration(190), duration(3599.6), duration(null)]).toEqual(['4ms', '500ms', '41.2s', '3m10s', '60m00s', '-']);
  });

  it('prints per-file changes for --diff', () => {
    const lines = formatCoverageDiff(report, plain).split('\n');
    expect(lines[0].split(/\s{2,}/)).toEqual(['Since 1a2b3c4', 'Methods', 'Reached', 'Branches', 'Tests', 'Keep', 'Redundant', 'Weak']);
    expect(rowOf(lines.join('\n'), 'src/cart.py').split(/\s{2,}/)).toEqual(['src/cart.py', '3', '3 (+1)', '41% (+11)', '0', '0', '0', '0']);
    expect(rowOf(lines.join('\n'), 'src/old.py').split(/\s{2,}/)).toEqual(['src/old.py', '1', '1', '100%', '0', '0', '0', '0', 'removed']);
    expect(rowOf(lines.join('\n'), 'tests/test_cart.py').split(/\s{2,}/)).toEqual(['tests/test_cart.py', '0', '0', '-', '5 (+2)', '3 (+1)', '1 (+1)', '1']);
    expect(lines.at(-1).split(/\s{2,}/)).toEqual(['All', '6', '4', '54% (+9)', '5 (+2)', '3 (+1)', '1 (+1)', '1']);
    expect(formatCoverageDiff({ ...report, diff: null })).toBe('');
  });
});

describe('coverage report with --since', () => {
  // The branch changed four lines of code in cart.py, one of which did not run, every line of code in tax.py, which all ran, and a
  // file no coverage report covers. The problems on what it changed are the edge case on apply_discount and one under the floor.
  const branch = { ref: 'origin/main', base: '1a2b3c4d5e6f', patch: { hit: 5, total: 6 }, units: ['m1', 'm2'], findings: ['d4e5f6a7', 'e1e2e3e4'],
    files: [{ path: 'src/cart.py', changed: 6, patch: { hit: 3, total: 4 }, missed: [12] }, { path: 'src/new.py', changed: 10, patch: null },
      { path: 'src/tax.py', changed: 2, patch: { hit: 2, total: 2 }, missed: [] }] };
  const onBranch = { ...report, diff: null, failed: [], branch, totals: { ...report.totals, drop: { count: 0, cost: {} } } };

  it('prints changed files and their problems', () => {
    const text = formatCoverage(onBranch, { min: 0.5, ...plain });
    const [table, problems, ...rest] = text.split('\n\n');
    expect(rest).toEqual([]);
    // Only the files with changed code the tests missed, and one nothing measured; tax.py ran every changed line.
    expect(table.split('\n').map(line => line.split(/\s{2,}/))).toEqual([
      ['Changed since origin/main', 'Untested lines', 'Patch coverage'],
      ['src/cart.py', '1', '75%'],
      ['src/new.py', 'not measured', '-'],
      ['All changed source', '1', '83%'],
    ]);
    expect(problems.split('\n')[0]).toBe('src/cart.py');
    expect(problems).toContain('d4e5f6a7');
    // Under the floor, and elsewhere in the repository: neither is listed.
    expect(problems).not.toContain('e1e2e3e4');
    expect(text).not.toContain('a91c2e0f');
    expect(listedFindings(onBranch, { min: 0.5 }).map(finding => finding.id)).toEqual(['d4e5f6a7']);
    // The count line says how many problems are in changed code, and counts the rest apart.
    expect(coverageCount(onBranch, { min: 0.5 })).toBe('/repo at commit 9f8e7d6: 6 methods, 5 tests, 1 problem in changed code, 3 elsewhere');
  });

  it('says when nothing changed', () => {
    const quiet = { ...onBranch, branch: { ...branch, files: [], patch: null, units: [], findings: [] } };
    expect(formatCoverage(quiet, { min: 0.5, ...plain })).toBe('No source files changed since origin/main.\n\nNo problems in code changed since origin/main.');
    expect(listedFindings(quiet, { min: 0.5 })).toEqual([]);
  });
});

describe('perch coverage', () => {
  function capture() {
    const out = [], err = [];
    return { out, err, io: { stdout: text => out.push(text), stderr: text => err.push(text), env: {} } };
  }

  it('prints its help', async () => {
    const { out, io } = capture();
    expect(await main(['coverage', '--help'], io)).toBe(0);
    expect(out[0]).toContain('perch coverage: Test coverage, and which tests are worth keeping');
    for (const flag of ['--depth N', '--diff REF', '--html FILE', '--filter', '--min', '--paths', '--json']) expect(out[0]).toContain(flag);
    expect(out[0]).toContain('PERCH_BASE_URL');
    expect(await main(['--help'], io)).toBe(0);
    expect(out.at(-1)).toContain('coverage [target]');
  });

  it('rejects an unknown kind', async () => {
    const { err, io } = capture();
    expect(await main(['coverage', '--filter', 'kind=bogus'], io)).toBe(2);
    expect(err.join('\n')).toContain('kind "bogus" is not one of untested, edge_case, redundant, asserts_mock');
    expect(err.join('\n')).toContain('perch coverage --help');
    expect(await main(['coverage', '--depth', '0'], io)).toBe(2);
    expect(err.join('\n')).toContain('--depth must be a positive integer');
    expect(await main(['coverage', '--closed'], io)).toBe(2);
  });
});
