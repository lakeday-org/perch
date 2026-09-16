/** Thin git wrapper; hooks are disabled so the operator's global hook path never runs. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

export async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch (error) {
    const detail = (error.stderr || error.message || '').toString().trim();
    throw new Error(`git ${args.filter(arg => !arg.startsWith('-c') || arg.length > 2).join(' ')} failed: ${detail}`);
  }
}

export const repoRoot = dir => git(['rev-parse', '--show-toplevel'], dir).then(text => text.trim());
export const revision = (root, ref = 'HEAD') => git(['rev-parse', '--verify', `${ref}^{commit}`], root).then(text => text.trim());
export const originUrl = root => git(['remote', 'get-url', 'origin'], root).then(text => text.trim()).catch(() => null);

/** Tracked blobs at a revision with their sizes. */
export async function listTree(root, rev) {
  const text = await git(['ls-tree', '-r', '-l', '-z', rev], root);
  return text.split('\0').filter(Boolean).map(entry => {
    const match = /^(\d+) (\w+) ([0-9a-f]+) +(\d+|-)\t(.*)$/s.exec(entry);
    if (!match) throw new Error(`Unexpected ls-tree entry: ${entry}`);
    return { mode: match[1], type: match[2], sha: match[3], size: match[4] === '-' ? 0 : Number(match[4]), path: match[5] };
  });
}

export async function addWorktree(root, dir, rev) {
  if (existsSync(dir)) await removeWorktree(root, dir);
  await git(['worktree', 'prune'], root);
  await mkdir(dirname(dir), { recursive: true });
  await git(['worktree', 'add', '--detach', dir, rev], root);
}

export async function removeWorktree(root, dir) {
  try { await git(['worktree', 'remove', '--force', dir], root); }
  catch { await rm(dir, { recursive: true, force: true }); }
  await git(['worktree', 'prune'], root).catch(() => {});
}

/** Restore the workspace to the scanned revision, keeping dependency directories. */
export async function resetWorkspace(dir, rev) {
  await git(['reset', '-q'], dir).catch(() => {});
  await git(['checkout', '--force', '--detach', rev], dir);
  await git(['clean', '-fd', '-e', 'node_modules', '-e', '.venv', '-e', 'target'], dir);
}

/** Keep the results directory out of `git status` when it lives inside the repository. */
export async function excludeFromStatus(root, pattern) {
  const gitDir = (await git(['rev-parse', '--git-common-dir'], root)).trim();
  const excludePath = join(gitDir.startsWith('/') ? gitDir : join(root, gitDir), 'info', 'exclude');
  const current = await readFile(excludePath, 'utf8').catch(() => '');
  if (current.split('\n').includes(pattern)) return;
  await mkdir(dirname(excludePath), { recursive: true });
  await appendFile(excludePath, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`);
}
