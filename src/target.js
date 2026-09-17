/** Resolve a scan target to a local repository root, cloning GitHub repositories on demand. */
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { git, originUrl, repoRoot } from './git.js';

export function parseGithub(text) {
  if (!text) return null;
  const url = /^(?:https?:\/\/|git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(text);
  if (url) return { owner: url[1], repo: url[2] };
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(text);
  if (short && !text.startsWith('.') && !existsSync(text)) return { owner: short[1], repo: short[2] };
  return null;
}

/**
 * A clone is made beside where it belongs and moved in, because two scans of the same repository start together seeing no clone
 * and both begin one. A rename is atomic, so one of them takes the directory and the other finds a finished clone rather than
 * git writing into a tree git is already writing into.
 *
 * A directory there without a `.git` is a clone that was killed partway. Nothing can clone into it and nothing can read it, so
 * it is cleared: it was perch's own copy of somebody else's repository and holds nothing that was not fetched.
 */
export async function cloneInto(dir, url, log = () => {}) {
  if (existsSync(join(dir, '.git'))) {
    log('fetching');
    await git(['fetch', '--prune', 'origin'], dir);
    await git(['checkout', '--force', '--detach', 'origin/HEAD'], dir);
    return;
  }
  log('cloning');
  await mkdir(dirname(dir), { recursive: true });
  const staging = `${dir}.${randomUUID().slice(0, 8)}`;
  await git(['clone', url, staging]);
  try { await rename(staging, dir); } catch (error) {
    if (existsSync(join(dir, '.git'))) { await rm(staging, { recursive: true, force: true }); return; }
    await rm(dir, { recursive: true, force: true });
    try { await rename(staging, dir); } catch (again) { await rm(staging, { recursive: true, force: true }); throw again ?? error; }
  }
}

export async function resolveTarget(target = '.', { out, log = () => {} } = {}) {
  const github = parseGithub(target);
  if (github) {
    const base = out ?? join(process.cwd(), '.perch');
    const dir = join(base, 'repos', github.owner, github.repo);
    await cloneInto(dir, `https://github.com/${github.owner}/${github.repo}.git`, what => log(`${what} ${github.owner}/${github.repo}`));
    return { kind: 'github', root: dir, github, out: base, label: `${github.owner}/${github.repo}` };
  }
  // A target that is not there reads as a spawn failure from deep inside git, which says the wrong thing about the wrong tool.
  const where = resolve(target);
  if (!existsSync(where)) throw new Error(`${target} is not a directory, a repository, or a GitHub url. perch scan --help`);
  const root = await repoRoot(where);
  return { kind: 'local', root, github: parseGithub(await originUrl(root)), out: out ?? join(root, '.perch'), label: root };
}
