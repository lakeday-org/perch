import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { coverageCount, coverageDetails, formatCoverage, formatCoverageDiff, listedFindings, parseCoverageFilters } from '../src/coverage-report.js';

/**
 * A report written out by hand, in the shape the contract gives it, so the formatting is checked against numbers chosen here rather
 * than numbers the engine happened to produce. Two source files, one test file, and findings of three kinds.
 */
const totalsOf = values => ({ methods: 0, reached: 0, useful_reached: 0, mutants: 0, killed: 0, score: null, survived: 0, tests: 0, useful: 0, redundant: 0, weak: 0, infra: 0, ...values });
const report = {
  revision: '9f8e7d6c5b4a', root: '/repo', created_at: '2026-09-28T10:00:00.000Z', model: 'jev-1', depth: 3, min: 50,
  totals: { methods: 6, reached: 4, useful_reached: 4, mutants: 15, killed: 8, score: 8 / 15, survived: 3,
    tests: 5, useful: 3, redundant: 1, weak: 1, infra: 0, drop: { count: 2, unreached: [] } },
  files: [
    { path: 'src/tax.py', kind: 'source', language: 'python', lines: [], methods: ['m4', 'm5', 'm6'], tests: [],
      totals: totalsOf({ methods: 3, reached: 1, useful_reached: 1, mutants: 3, killed: 1, score: 1 / 3, survived: 2 }) },
    { path: 'src/cart.py', kind: 'source', language: 'python', lines: [], methods: ['m1', 'm2', 'm3'], tests: [],
      totals: totalsOf({ methods: 3, reached: 3, useful_reached: 3, mutants: 12, killed: 7, score: 7 / 12, survived: 1 }) },
    { path: 'tests/test_cart.py', kind: 'test', language: 'python', lines: [], methods: [], tests: ['t1', 't2', 't3', 't4', 't5'],
      totals: totalsOf({ tests: 5, useful: 3, redundant: 1, weak: 1, infra: 0 }) },
  ],
  methods: [],
  tests: [
    { id: 't1', path: 'tests/test_cart.py' },
    { id: 't2', path: 'tests/test_cart.py' },
  ],
  findings: [
    { id: 'a91c2e0f', kind: 'redundant', subject: 'test', unit: 't2', path: 'tests/test_cart.py', line: 41, name: 'test_discount_20',
      probability: 0.88, note: 'Decides happy_path of apply_discount, like test_discount_10 at line 12.' },
    // One whose method could not be asked, so it carries no probability and no floor can judge it.
    { id: 'b7d31e22', kind: 'survived', subject: 'method', unit: 'm5', mutant: '30:11:*>/', path: 'src/tax.py', line: 30, name: 'round_tax',
      probability: null, note: 'With `/` instead of `*`, the 1 test reaching it still passes.' },
    { id: 'c0ffee11', kind: 'survived', subject: 'method', unit: 'm4', mutant: '9:7:<><=', path: 'src/tax.py', line: 9, name: 'rate_for',
      probability: 0.65, note: 'With `<=` instead of `<`, the 1 test reaching it still passes.' },
    { id: 'd4e5f6a7', kind: 'survived', subject: 'method', unit: 'm1', mutant: '17:7:>>>=', path: 'src/cart.py', line: 17, name: 'apply_discount',
      probability: 0.72, note: 'With `>=` instead of `>`, none of the 2 tests reaching it fails.' },
    // Under the floor, so it is on the report and off the list.
    { id: 'e1e2e3e4', kind: 'survived', subject: 'method', unit: 'm2', mutant: '50:9:&&>||', path: 'src/cart.py', line: 50, name: 'total',
      probability: 0.31, note: 'With `||` instead of `&&`, none of the 2 tests reaching it fails.' },
  ],
  failed: [{ unit: 'm9', subject: 'method', path: 'src/tax.py', name: 'legacy', error: 'too long to send' }],
  baseline: { revision: '1a2b3c4d5e6f', created_at: '2026-09-20T10:00:00.000Z' },
  diff: {
    from: { revision: '1a2b3c4d5e6f', created_at: '2026-09-20T10:00:00.000Z' },
    to: { revision: '9f8e7d6c5b4a', created_at: '2026-09-28T10:00:00.000Z' },
    totals: { methods: { before: 6, after: 6 }, reached: { before: 4, after: 4 }, score: { before: 0.45, after: 0.54 },
      tests: { before: 3, after: 5 }, useful: { before: 2, after: 3 }, redundant: { before: 0, after: 1 }, weak: { before: 1, after: 1 },
      infra: { before: 0, after: 0 }, survived: { before: 4, after: 3 } },
    files: [
      { path: 'src/cart.py', before: totalsOf({ methods: 3, reached: 2, score: 0.3 }), after: totalsOf({ methods: 3, reached: 3, score: 0.41 }) },
      { path: 'tests/test_cart.py', before: totalsOf({ tests: 3, useful: 2, weak: 1 }), after: totalsOf({ tests: 5, useful: 3, redundant: 1, weak: 1 }) },
      { path: 'src/old.py', before: totalsOf({ methods: 1, reached: 1, score: 1 }), after: null },
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
    expect(source[0]).toMatch(/^Source files\s+Methods tested\s+Mutation score\s+Survived$/);
    // Files in path order, whatever order the report had them in.
    expect(source.slice(1).map(line => line.split(/\s{2,}/)[0])).toEqual(['src/cart.py', 'src/tax.py', 'All source']);
    // Of cart.py's 12 mutants, 7 are killed, and one survivor is over the floor.
    expect(rowOf(text, 'src/cart.py').split(/\s{2,}/)).toEqual(['src/cart.py', '3 of 3', '58% (7 of 12)', '1']);
    // tax.py's two listed survivors: one over the floor, one whose method could not be asked.
    expect(rowOf(text, 'src/tax.py').split(/\s{2,}/)).toEqual(['src/tax.py', '1 of 3', '33% (1 of 3)', '2']);
    expect(rowOf(text, 'All source').split(/\s{2,}/)).toEqual(['All source', '4 of 6', '53% (8 of 15)', '3']);
    // A file with no mutants is a dash and not a zero.
    const bare = { ...report, files: [{ ...report.files[0], totals: totalsOf({ methods: 3, reached: 1, useful_reached: 1 }) }], findings: [] };
    expect(rowOf(formatCoverage(bare, { min: 0.5, ...plain }), 'src/tax.py').split(/\s{2,}/)).toEqual(['src/tax.py', '1 of 3', '-', '0']);
    // Quality is the tests worth keeping, of all of them; then why the rest are not, and what the tests touch.
    expect(rowOf(text, 'Test files').split(/\s{2,}/)).toEqual(['Test files', 'Quality', 'Duplicates', 'Checks nothing', 'Live services']);
    expect(rowOf(text, 'tests/test_cart.py ').split(/\s{2,}/)).toEqual(['tests/test_cart.py', '60% (3 of 5)', '1', '1', '0']);
    expect(rowOf(text, 'All tests').split(/\s{2,}/)).toEqual(['All tests', '60% (3 of 5)', '1', '1', '0']);
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
    expect(rowOf(blocks[1], '  c0ffee11').split(/\s{2,}/).slice(1)).toEqual(['c0ffee11', '9', 'survived', '65%', 'rate_for', 'With `<=` instead of `<`, the 1 test reaching it still passes.']);
    expect(rowOf(blocks[1], '  b7d31e22').split(/\s{2,}/).slice(1)).toEqual(['b7d31e22', '30', 'survived', '-', 'round_tax', 'With `/` instead of `*`, the 1 test reaching it still passes.']);
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
    const filters = parseCoverageFilters('kind=redundant');
    expect(filters).toEqual([{ key: 'kind', value: 'redundant' }]);
    const text = formatCoverage(report, { min: 0.5, filters, ...plain });
    expect(text).toContain('a91c2e0f');
    expect(text).not.toContain('c0ffee11');
    expect(text).not.toContain('b7d31e22');
    expect(text).not.toContain('d4e5f6a7');
    expect(rowOf(text, 'src/cart.py').split(/\s{2,}/)).toEqual(['src/cart.py', '3 of 3', '58% (7 of 12)', '1']);
    // A second value is another alternative for the same key, and a spelling with a space or a hyphen is the same kind.
    expect(parseCoverageFilters('kind=checks nothing,redundant')).toEqual([{ key: 'kind', value: 'checks_nothing' }, { key: 'kind', value: 'redundant' }]);
    expect(() => parseCoverageFilters('kind=bogus')).toThrow(/kind "bogus" is not one of survived, redundant, checks_nothing, mocked, infra/);
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

  it('keeps what no framework covers for --verbose', () => {
    const scoped = { ...report, scope: { frameworks: [{ name: 'Vitest', version: '2.1.9', config: 'vitest.config.js', tests: 40 }], left_out: 3 } };
    expect(coverageDetails(scoped)).toEqual(['3 files no test framework covers left out']);
    expect(coverageDetails(report)).toEqual([]);
  });

  it('prints per-file changes for --diff', () => {
    const lines = formatCoverageDiff(report, plain).split('\n');
    expect(lines[0].split(/\s{2,}/)).toEqual(['Since 1a2b3c4', 'Methods', 'Reached', 'Mutation score', 'Tests', 'Keep', 'Redundant', 'Checks nothing']);
    expect(rowOf(lines.join('\n'), 'src/cart.py').split(/\s{2,}/)).toEqual(['src/cart.py', '3', '3 (+1)', '41% (+11)', '0', '0', '0', '0']);
    expect(rowOf(lines.join('\n'), 'src/old.py').split(/\s{2,}/)).toEqual(['src/old.py', '1', '1', '100%', '0', '0', '0', '0', 'removed']);
    expect(rowOf(lines.join('\n'), 'tests/test_cart.py').split(/\s{2,}/)).toEqual(['tests/test_cart.py', '0', '0', '-', '5 (+2)', '3 (+1)', '1 (+1)', '1']);
    expect(lines.at(-1).split(/\s{2,}/)).toEqual(['All', '6', '4', '54% (+9)', '5 (+2)', '3 (+1)', '1 (+1)', '1']);
    expect(formatCoverageDiff({ ...report, diff: null })).toBe('');
  });
});

describe('coverage report with --since', () => {
  // The branch changed apply_discount and total. The problems on what it changed are the survivor on apply_discount and one under
  // the floor.
  const branch = { ref: 'origin/main', base: '1a2b3c4d5e6f', units: ['m1', 'm2'], findings: ['d4e5f6a7', 'e1e2e3e4'] };
  const onBranch = { ...report, diff: null, failed: [], branch, totals: { ...report.totals, drop: { count: 0 } } };

  it("prints the changed code's problems", () => {
    const text = formatCoverage(onBranch, { min: 0.5, ...plain });
    const [problems, ...rest] = text.split('\n\n');
    expect(rest).toEqual([]);
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
    const quiet = { ...onBranch, branch: { ...branch, units: [], findings: [] } };
    expect(formatCoverage(quiet, { min: 0.5, ...plain })).toBe('No problems in code changed since origin/main.');
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
    expect(err.join('\n')).toContain('kind "bogus" is not one of survived, redundant, checks_nothing, mocked, infra');
    expect(err.join('\n')).toContain('perch coverage --help');
    expect(await main(['coverage', '--depth', '0'], io)).toBe(2);
    expect(err.join('\n')).toContain('--depth must be a positive integer');
    expect(await main(['coverage', '--closed'], io)).toBe(2);
  });
});
