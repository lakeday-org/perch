/**
 * Matching a JUnit testcase to a test by its framework's names, for the shapes a fixture application's single describe level
 * does not reach. The expected matches are written by hand from each reporter's documented output.
 */
import { expect, it } from 'vitest';
import { namesOf, patternsOf, rootsOf, runNames } from '../src/runs/index.js';
import { templatePattern } from '../src/runs/javascript.js';

const context = { root: '/work', roots: rootsOf(['package.json']) };
const file = { language: 'typescript', path: 'test/cart.test.ts' };
const node = (name, suite) => ({ id: `test/cart.test.ts::${[...suite, name].join(' > ')}`, qualified_name: [...suite, name].join(' > '),
  path: 'test/cart.test.ts', case: { name, suite, framework: 'node:test' } });
const matches = (test, run) => namesOf(test, file, context).some(name => runNames(run, context).includes(name));

it('matches nested node:test suites', () => {
  // node:test writes each describe block as a testsuite around its tests: <testsuite name="cart"><testsuite name="discounts">.
  const deep = { name: 'rounds down', classname: 'test', file: '/work/test/cart.test.ts', suite: 'discounts', suites: ['cart', 'discounts'] };
  expect(matches(node('rounds down', ['cart', 'discounts']), deep)).toBe(true);
  expect(matches(node('rounds down', ['discounts']), deep)).toBe(false);
  expect(matches(node('rounds down', ['cart']), deep)).toBe(false);
  // A test in no describe block is a testcase outside any testsuite.
  const top = { name: 'rounds down', classname: 'test', file: '/work/test/cart.test.ts', suite: null, suites: [] };
  expect(matches(node('rounds down', []), top)).toBe(true);
  expect(matches(node('rounds down', ['cart', 'discounts']), top)).toBe(false);
});

it('matches .each cases by filled-in title', () => {
  const each = (name, suite = []) => ({ ...node(name, suite), case: { name, suite, framework: 'vitest', parametrized: true } });
  const vitest = name => ({ name, classname: 'test/cart.test.ts', file: null, suite: null, suites: [] });
  const matchesVitest = (test, run) => {
    const names = runNames(run, context);
    return namesOf(test, file, context).some(name => names.includes(name))
      || patternsOf(test, file, context).some(({ prefix, pattern }) => names.some(name => name.startsWith(prefix) && pattern.test(name.slice(prefix.length))));
  };
  // Vitest reports `it.each([[1, 2]])('adds %i and %i')` as `adds 1 and 2`, and `describe.each([{ n: 3 }])('with $n')` as `with 3`.
  expect(matchesVitest(each('adds %i and %i'), vitest('adds 1 and 2'))).toBe(true);
  expect(matchesVitest(each('works', ['with $n']), vitest('with 3 > works'))).toBe(true);
  expect(matchesVitest(each('adds %i and %i'), vitest('subtracts 1 and 2'))).toBe(false);
  // `%%` is a literal percent sign, not a placeholder.
  expect(matchesVitest(each('takes %i%%'), vitest('takes 10%'))).toBe(true);
  expect(matchesVitest(each('takes %i%%'), vitest('takes 10'))).toBe(false);
  expect(templatePattern('a.b %s (c)').test('a.b x (c)')).toBe(true);
  expect(templatePattern('a.b %s (c)').test('aXb x (c)')).toBe(false);
});
