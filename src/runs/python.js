/**
 * Python's names for a test: pytest's JUnit classname and name and pytest-cov's context, and unittest's test id as
 * unittest-xml-reporting and coverage.py's `test_function` dynamic context write it.
 */
import { projectRoots, under } from './paths.js';

export const family = 'python';
export const languages = new Set(['python']);
/**
 * pytest names tests from its rootdir, the directory of the ini file it found. unittest names them from the top-level directory
 * it was run in, which a project marks with its pyproject.toml.
 */
const ROOT_FILES = new Set(['pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg']);
export const roots = paths => projectRoots(paths, ROOT_FILES);

/**
 * pytest's JUnit classname is the file's module path from its rootdir, then any classes; its name is the function. pytest-cov's
 * context is the test's node id: the file from the rootdir, then the classes and the function.
 *
 * A unittest TestCase method is named by its id: the module it was imported as, the class and the method, dotted. The module is
 * the file's path from the top-level directory, which `python -m unittest discover` makes the directory it runs in. Its JUnit
 * classname, as unittest-xml-reporting writes it, is the id without the method, and its name is the method, which is the same
 * pair as pytest's. coverage.py's `dynamic_context = test_function` names what the method ran by the whole id. perch needs the
 * context set that way, in the project's coverage configuration; a static `--context` names a run, not a test.
 */
export function testNames(node, { roots: found }) {
  const { case: test } = node, suite = test.suite ?? [];
  const keys = [], full = [];
  for (const root of found.python) {
    const rel = under(root, node.path);
    if (rel === null) continue;
    const module = rel.replace(/\.py$/, '').split('/').join('.');
    keys.push(`py\0${[module, ...suite].join('.')}\0${test.name}`);
    const nodeid = [rel, ...suite, test.name].join('::');
    keys.push(`ctx\0${nodeid}`);
    full.push(nodeid);
    if (test.framework === 'unittest') {
      const id = [module, ...suite, test.name].join('.');
      keys.push(`ctx\0${id}`);
      full.push(id);
    }
  }
  return { keys, full };
}

/** A parametrized case is the function's name with `[params]` after it. */
export const runNames = run => [`py\0${run.classname ?? ''}\0${run.name.replace(/\[.*\]$/s, '')}`];
