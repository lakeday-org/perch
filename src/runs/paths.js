/** Paths as test frameworks write them: relative to a project root, or absolute on the machine that ran the tests. */
import { dirname, isAbsolute, relative, sep } from 'node:path';

/** `path` as it is written from `root`, or null when it is not under it. */
export const under = (root, path) => (root === '' ? path : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null);

/** A file as a report names it: relative to the repository when it is inside it, otherwise as it is. */
export const shownPath = (root, path) => {
  const inside = relative(root, path);
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside.split(sep).join('/') : path;
};

/**
 * The directories that hold one of `names`, and the repository root when `withRoot`: the places a framework can name a test
 * from. pytest names from its rootdir, the directory of the ini file it found; Vitest and Jest from their project root, the
 * directory of the package.json they run in; a Rust crate is the directory of its Cargo.toml and nothing else.
 */
export function projectRoots(paths, names, withRoot = true) {
  const roots = new Set(withRoot ? [''] : []);
  for (const path of paths ?? []) if (names.has(path.split('/').at(-1))) roots.add(path.includes('/') ? dirname(path) : '');
  return [...roots];
}
