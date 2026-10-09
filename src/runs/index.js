/**
 * How each test framework names a test in its reports, one module per language family. A family says which names its tests
 * go by and which names a JUnit testcase could be; a testcase is matched to the one test that has one of its names, and to
 * nothing when none or several do. Each name is prefixed by its family so names from two frameworks never meet.
 *
 * A family module exports `family`, `languages`, `roots(paths)` (the directories its frameworks name tests from), `testNames(node,
 * context)` returning `{ keys, full }` (`full` being the framework's full test names, which an LCOV TN may be), and
 * `runNames(run, context)`.
 */
import * as python from './python.js';
import * as javascript from './javascript.js';
import * as jvm from './jvm.js';
import * as native from './native.js';
import * as rust from './rust.js';

export const FAMILIES = [python, javascript, jvm, native, rust];

/** Each family's project roots, by family. */
export const rootsOf = paths => Object.fromEntries(FAMILIES.map(family => [family.family, family.roots(paths)]));

/**
 * Every name this test goes by. An LCOV test name (TN) is the test's id, its qualified name, or a framework's full name; geninfo
 * allows only letters, digits and `_` in a TN and replaces anything else with `_`, so each full name is indexed both ways.
 */
export function namesOf(node, file, context) {
  const names = [`tn\0${node.id}`, `tn\0${node.qualified_name}`];
  for (const family of FAMILIES) {
    if (!family.languages.has(file.language)) continue;
    const { keys, full } = family.testNames(node, { ...context, file });
    names.push(...keys);
    for (const name of full) names.push(`tn\0${name}`, `tn\0${name.replace(/\W/g, '_')}`);
  }
  return names;
}

/**
 * The title patterns of a test whose runs are named by filling in a template, `.each` in Vitest and Jest: `{ prefix, pattern }`,
 * a run name matching when it starts with the prefix and the rest matches the pattern. A family with none returns none.
 */
export function patternsOf(node, file, context) {
  return FAMILIES.filter(family => family.languages.has(file.language))
    .flatMap(family => family.testNames(node, { ...context, file }).patterns ?? []);
}

/** Every name one JUnit testcase could be, by each family's way of writing one. */
export const runNames = (run, context) => FAMILIES.flatMap(family => family.runNames(run, context));
