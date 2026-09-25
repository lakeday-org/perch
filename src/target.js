/** Resolve a scan target to its Git root, or to a directory when Git is unavailable. */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { originUrl, repoRoot, revision } from './git.js';

export function parseGithub(text) {
  if (!text) return null;
  const url = /^(?:https?:\/\/|git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(text);
  if (url) return { owner: url[1], repo: url[2] };
  return null;
}

/**
 * A target names how much code to read: the directory or file given, or everything when nothing is given.
 *
 * In Git, the root is the repository because the call graph spans files from one commit. Without Git, the root is the target
 * directory (or a file's parent). The path below that root becomes `scope`, so a file target reads only that file.
 */
export async function resolveTarget(target = '.', { out } = {}) {
  // A target that is not there reads as a spawn failure from deep inside git, which says the wrong thing about the wrong tool.
  if (!existsSync(resolve(target))) throw new Error(`${target} is not a file or directory. perch scan --help`);
  // git reports the root with every symlink resolved. The target has to be resolved the same way before one is taken relative
  // to the other, or /var/folders/x on macOS sits outside /private/var/folders/x, the scope matches nothing, and a run of zero
  // methods reports itself complete.
  const where = realpathSync(resolve(target));
  // git is asked from a directory, so a file target is asked from the directory holding it.
  const from = statSync(where).isDirectory() ? where : dirname(where);
  const enclosing = await repoRoot(from).catch(() => null);
  const gitRoot = enclosing && await revision(enclosing).then(() => enclosing, () => null);
  const root = enclosing || from;
  const inside = relative(root, where);
  return {
    kind: gitRoot ? 'local' : 'filesystem',
    root,
    scope: inside ? inside.split(sep).join('/') : null,
    github: gitRoot ? parseGithub(await originUrl(root)) : null,
    out: out ?? resolve(root, '.perch'),
    label: root,
  };
}
