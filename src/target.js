/** Resolve a scan target to a repository root and the path under it the run covers. */
import { existsSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { originUrl, repoRoot } from './git.js';

export function parseGithub(text) {
  if (!text) return null;
  const url = /^(?:https?:\/\/|git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(text);
  if (url) return { owner: url[1], repo: url[2] };
  return null;
}

/**
 * perch reads the repository it is standing in, the way a linter does. A target names how much of it to read: the directory or
 * file given, or everything when nothing is given.
 *
 * The root has to be the repository, since perch reads a commit and a call graph spans files. So the target becomes `scope`, the
 * path under that root, and the walk narrows to it. Resolving to the root and dropping the rest is what made `perch scan docs/`
 * read every method in the repository and bill for it.
 */
export async function resolveTarget(target = '.', { out } = {}) {
  const where = resolve(target);
  // A target that is not there reads as a spawn failure from deep inside git, which says the wrong thing about the wrong tool.
  if (!existsSync(where)) throw new Error(`${target} is not a file or directory. perch scan --help`);
  // git is asked from a directory, so a file target is asked from the directory holding it.
  const from = statSync(where).isDirectory() ? where : dirname(where);
  // Same, for a path that is in no repository at all: git says it, and perch says which path and what to do about it.
  const root = await repoRoot(from).catch(() => {
    throw new Error(`${target} is not in a git repository. perch reads a commit, so it needs one. perch scan --help`);
  });
  const inside = relative(root, where);
  return {
    kind: 'local',
    root,
    scope: inside ? inside.split(sep).join('/') : null,
    github: parseGithub(await originUrl(root)),
    out: out ?? resolve(root, '.perch'),
    label: root,
  };
}
