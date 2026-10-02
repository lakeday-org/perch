/**
 * C and C++ test frameworks' names for a test: GoogleTest's suite and name, Catch2's test case name, doctest's file and name.
 *
 * Catch2's JUnit reporter leaves out a test case that made no assertion, so a test that asserts nothing has no run unless the
 * tests are run with `--warn NoAssertions`, which Catch2 documents for exactly that test and which makes it write one.
 */
import { isAbsolute } from 'node:path';
import { shownPath } from './paths.js';

export const family = 'native';
export const languages = new Set(['c', 'cpp']);
export const roots = () => [];
const GTEST_MACROS = new Set(['TEST', 'TEST_F', 'TEST_P', 'TYPED_TEST', 'TYPED_TEST_P']);

/**
 * GoogleTest names a test by its suite and name. Catch2 by its test case name, which it allows once per binary, under the
 * classname `<binary>.global`, or `<binary>.<file>` when run with `-#`, which tags each test with its file's name less its
 * extension, and a TEST_CASE_METHOD under `<binary>.<fixture class>`. doctest by the name, under the classname of the file it is in as the compiler was given it.
 */
export function testNames(node) {
  const { case: test } = node, suite = test.suite ?? [];
  if (GTEST_MACROS.has(test.framework)) return { keys: [`gtest\0${suite[0]}\0${test.name}`], full: [`${suite[0]}.${test.name}`] };
  if (test.framework === 'catch2') {
    const stem = node.path.split('/').at(-1).replace(/\.[^.]*$/, '');
    // A TEST_CASE_METHOD's classname is its fixture class's.
    const fixture = test.fixture ? [`catch2\0${test.fixture}\0${test.name}`] : [];
    return { keys: [`catch2\0global\0${test.name}`, `catch2\0${stem}\0${test.name}`, ...fixture], full: [] };
  }
  if (test.framework === 'doctest') return { keys: [`doctest\0${node.path}\0${test.name}`], full: [] };
  return { keys: [], full: [] };
}

/**
 * The test case names a Catch2 or doctest testcase could be. Each writes a SECTION or SUBCASE as `Test case/Section/Inner`, so
 * the test case is the name up to one of its slashes, or the whole name; a name that could be two test cases matches neither.
 */
const caseNames = name => name.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));

/**
 * GoogleTest writes a value-parameterized case as `Prefix/Suite` and `Name/n`, and a typed one as `Suite/n`. Catch2's classname
 * is `<binary>.<class>`, and the binary's name may hold a dot, so the class is whatever follows any one of its dots.
 */
export function runNames(run, { root }) {
  const names = [];
  const classname = run.classname ?? '';
  const suite = classname.split('/');
  const gtest = suite.length === 1 ? suite[0] : suite.length === 2 ? (/^\d+$/.test(suite[1]) ? suite[0] : suite[1]) : null;
  if (gtest) names.push(`gtest\0${gtest}\0${run.name.replace(/\/\d+$/, '')}`);
  const cases = caseNames(run.name);
  for (let dot = classname.indexOf('.'); dot !== -1; dot = classname.indexOf('.', dot + 1)) {
    for (const name of cases) names.push(`catch2\0${classname.slice(dot + 1)}\0${name}`);
  }
  if (classname) {
    const file = isAbsolute(classname) ? shownPath(root, classname) : classname;
    for (const name of cases) names.push(`doctest\0${file}\0${name}`);
  }
  return names;
}
