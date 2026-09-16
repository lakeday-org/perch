/** Resolve a scan target to a local repository root, cloning GitHub repositories on demand. */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { git, originUrl, repoRoot } from './git.js';

export function parseGithub(text) {
  if (!text) return null;
  const url = /^(?:https?:\/\/|git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(text);
  if (url) return { owner: url[1], repo: url[2] };
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(text);
  if (short && !text.startsWith('.') && !existsSync(text)) return { owner: short[1], repo: short[2] };
  return null;
}

export async function resolveTarget(target = '.', { out, log = () => {} } = {}) {
  const github = parseGithub(target);
  if (github) {
    const base = out ?? join(process.cwd(), '.perch');
    const dir = join(base, 'repos', github.owner, github.repo);
    if (existsSync(join(dir, '.git'))) {
      log(`fetching ${github.owner}/${github.repo}`);
      await git(['fetch', '--prune', 'origin'], dir);
      await git(['checkout', '--force', '--detach', 'origin/HEAD'], dir);
    } else {
      log(`cloning ${github.owner}/${github.repo}`);
      await mkdir(dir, { recursive: true });
      await git(['clone', `https://github.com/${github.owner}/${github.repo}.git`, dir]);
    }
    return { kind: 'github', root: dir, github, out: base, label: `${github.owner}/${github.repo}` };
  }
  const root = await repoRoot(resolve(target));
  return { kind: 'local', root, github: parseGithub(await originUrl(root)), out: out ?? join(root, '.perch'), label: root };
}
