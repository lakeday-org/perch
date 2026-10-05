/**
 * JavaScript test frameworks' names for a test: Vitest's, Jest's, Mocha's and node:test's. Each names a test by the file it is
 * in and its title under the titles of the describe blocks around it, and each JUnit reporter writes those in its own places.
 *
 * Vitest's and node:test's reporters say which file and which describe blocks unambiguously as they come. jest-junit and
 * mocha-junit-reporter join the titles with a space by default, which cannot be split back apart, and jest-junit writes no file
 * by default, so perch needs each configured, in the ways their documentation offers:
 *
 *   jest-junit            addFileAttribute "true", ancestorSeparator " > ", classNameTemplate "{classname}", titleTemplate "{title}"
 *   mocha-junit-reporter  jenkinsMode true, suiteTitleSeparatedBy " > "
 *
 * Configured otherwise, their testcases match no test and are listed as unmatched.
 */
import { isAbsolute } from 'node:path';
import { projectRoots, shownPath, under } from './paths.js';

export const family = 'javascript';
export const languages = new Set(['javascript', 'typescript', 'tsx']);
const ROOT_FILES = new Set(['package.json']);
export const roots = paths => projectRoots(paths, ROOT_FILES);

/**
 * The frameworks a test can belong to, by where its `it` or `test` came from. Jest's and Mocha's are globals unless imported, and
 * so are Vitest's when it runs with `globals: true`.
 */
const FRAMEWORKS = {
  vitest: ['vitest'],
  '@jest/globals': ['jest'],
  mocha: ['mocha'],
  'node:test': ['node'],
  global: ['vitest', 'jest', 'mocha'],
};

/**
 * A `.each` title as the reporter fills it in, as a pattern: Vitest's and Jest's documented placeholders `%s %d %i %f %j %o %O %p
 * %c %# %$` each stand for one case's value, `%%` for a percent sign, and in a table of objects `$name`, `$name.path` and `$#`
 * for a field or the index, and `${...}` for the part of a title built at run time. Everything else in the title is literal.
 */
export function templatePattern(title) {
  let out = '';
  for (let at = 0; at < title.length;) {
    if (title.startsWith('%%', at)) { out += '%'; at += 2; continue; }
    if (title[at] === '%' && /[sdifjoOpc#$]/.test(title[at + 1] ?? '')) { out += '[\\s\\S]*?'; at += 2; continue; }
    // `${type}`: a part of a title built at run time, which perch writes this way.
    const field = /^\$(?:\{[^}]*\}|#|[A-Za-z_]\w*(?:\.\w+)*)/.exec(title.slice(at));
    if (field) { out += '[\\s\\S]*?'; at += field[0].length; continue; }
    out += title[at].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    at += 1;
  }
  return new RegExp(`^${out}$`);
}

/**
 * A test's name in each framework it can belong to: the file from each project root, and its titles joined by " > ". A test
 * declared with `.each` also gives a pattern per framework, since each case's run carries its own filled-in title.
 */
export function testNames(node, { roots: found }) {
  const { case: test } = node, suite = test.suite ?? [];
  const title = [...suite, test.name].join(' > ');
  const keys = [], patterns = [];
  for (const root of found.javascript) {
    const rel = under(root, node.path);
    if (rel === null) continue;
    for (const framework of FRAMEWORKS[test.framework] ?? []) {
      keys.push(`${framework}\0${rel}\0${title}`);
      if (test.parametrized) patterns.push({ prefix: `${framework}\0${rel}\0`, pattern: templatePattern(title) });
    }
  }
  return { keys, full: [], patterns };
}

/**
 * The names a JUnit testcase has in each framework's reporter:
 *
 * - Vitest: the classname is the file from the project root, and the name is the describe titles and the test's, joined by " > ".
 * - Jest, through jest-junit configured as above: `file` is the file from the project root, the classname is the describe titles
 *   joined by " > ", empty for a test in none, and the name is the test's title.
 * - Mocha, through mocha-junit-reporter configured as above: the same, except that `file` is on the testsuite and absolute. A
 *   test in no describe block is in Mocha's root suite, which has no file, so it matches nothing.
 * - node:test: `file` is on the testcase and absolute, the classname is always "test", and each describe block is a testsuite
 *   around it, named by its title, so a test two describes deep is inside two. A test in no describe block is a testcase outside
 *   any testsuite.
 */
export function runNames(run, { root }) {
  const at = path => (isAbsolute(path) ? shownPath(root, path) : path);
  const names = [];
  if (run.classname) names.push(`vitest\0${at(run.classname)}\0${run.name}`);
  if (run.file) {
    const file = at(run.file);
    const described = run.classname ? `${run.classname} > ${run.name}` : run.name;
    names.push(`jest\0${file}\0${described}`, `mocha\0${file}\0${described}`);
    names.push(`node\0${file}\0${[...run.suites, run.name].join(' > ')}`);
  }
  return names;
}
