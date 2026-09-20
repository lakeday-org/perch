/** Thin git wrapper; hooks are disabled so the operator's global hook path never runs. */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const execFileAsync = promisify(execFile);

export async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch (error) {
    const detail = (error.stderr || error.message || '').toString().trim();
    const failure = new Error(`git ${args.filter(arg => !arg.startsWith('-c') || arg.length > 2).join(' ')} failed: ${detail}`);
    failure.stdout = error.stdout?.toString() ?? '';
    throw failure;
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

/** The content of one tracked blob, read without a checkout. */
export const readBlob = (root, sha) => git(['cat-file', 'blob', sha], root);

/** Many blobs through one `git cat-file --batch` process, delivered in order to `onBlob(index, text)`. */
export function readBlobs(root, shas, onBlob) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', 'cat-file', '--batch'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = Buffer.alloc(0), index = 0, stderr = '';
    const drain = () => {
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline < 0) return;
        const header = pending.subarray(0, newline).toString();
        if (header.endsWith(' missing')) throw new Error(`git cat-file: ${header}`);
        const size = Number(header.split(' ')[2]);
        if (pending.length < newline + 1 + size + 1) return;
        onBlob(index++, pending.subarray(newline + 1, newline + 1 + size).toString('utf8'));
        pending = pending.subarray(newline + 1 + size + 1);
      }
    };
    child.stdout.on('data', chunk => { pending = Buffer.concat([pending, chunk]); try { drain(); } catch (error) { child.kill(); reject(error); } });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => (code === 0 && index === shas.length ? resolve() : reject(new Error(`git cat-file --batch failed: ${stderr.trim() || `read ${index} of ${shas.length} blobs`}`))));
    child.stdin.end(shas.map(sha => `${sha}\n`).join(''));
  });
}
