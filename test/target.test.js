import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { cloneInto, resolveTarget } from '../src/target.js';

const execFileAsync = promisify(execFile);

async function runGit(args, cwd) {
  await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd });
}

it('propagates a failed checkout of origin HEAD', async () => {
  const root = await mkdtemp(join(process.cwd(), '.target-test-'));
  const remote = join(root, 'remote.git');
  const source = join(root, 'source');
  const cache = join(root, 'cache');
  const cachedRepo = join(cache, 'repos', 'owner', 'repo');

  try {
    await runGit(['init', '--bare', '-q', remote], root);
    await mkdir(source);
    await runGit(['init', '-q', source], root);
    await runGit(['config', 'user.name', 'Fixture'], source);
    await runGit(['config', 'user.email', 'fixture@example.com'], source);
    await writeFile(join(source, 'README.md'), 'fixture\n');
    await runGit(['add', 'README.md'], source);
    await runGit(['commit', '-q', '-m', 'fixture'], source);
    await runGit(['branch', '-M', 'main'], source);
    await runGit(['remote', 'add', 'origin', remote], source);
    await runGit(['push', '-q', 'origin', 'main'], source);
    await runGit(['symbolic-ref', 'HEAD', 'refs/heads/missing'], remote);

    await mkdir(cachedRepo, { recursive: true });
    await runGit(['init', '-q', cachedRepo], root);
    await runGit(['remote', 'add', 'origin', remote], cachedRepo);
    await runGit(['fetch', '-q', 'origin'], cachedRepo);
    await runGit(['update-ref', '-d', 'refs/remotes/origin/HEAD'], cachedRepo);

    await expect(resolveTarget('owner/repo', { out: cache })).rejects.toThrow(/git checkout .*failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A bare repository with one commit, standing in for the GitHub url a real clone is given. */
async function remoteWithACommit(root) {
  const remote = join(root, 'remote.git'), source = join(root, 'source');
  await runGit(['init', '--bare', '-q', remote], root);
  await mkdir(source);
  await runGit(['init', '-q', source], root);
  await runGit(['config', 'user.name', 'Fixture'], source);
  await runGit(['config', 'user.email', 'fixture@example.com'], source);
  await writeFile(join(source, 'README.md'), 'fixture\n');
  await runGit(['add', 'README.md'], source);
  await runGit(['commit', '-q', '-m', 'fixture'], source);
  await runGit(['push', '-q', 'origin', 'HEAD:main'], source).catch(async () => {
    await runGit(['remote', 'add', 'origin', remote], source);
    await runGit(['push', '-q', 'origin', 'HEAD:main'], source);
  });
  return remote;
}

it('clones once when two runs want the same repository at the same time', async () => {
  const root = await mkdtemp(join(process.cwd(), '.target-test-'));
  try {
    const remote = await remoteWithACommit(root);
    const dir = join(root, 'cache', 'repos', 'owner', 'repo');
    // Both see no clone and both start one. Cloning straight into the directory had them writing into each other's tree.
    await Promise.all([cloneInto(dir, remote), cloneInto(dir, remote), cloneInto(dir, remote)]);
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
    // Nothing staged is left beside it, so the next run sees one clone and not a directory of half-finished ones.
    expect((await readdir(join(root, 'cache', 'repos', 'owner'))).sort()).toEqual(['repo']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('clones over a directory left behind by a clone that was killed partway', async () => {
  const root = await mkdtemp(join(process.cwd(), '.target-test-'));
  try {
    const remote = await remoteWithACommit(root);
    const dir = join(root, 'cache', 'repos', 'owner', 'repo');
    // Something there with no .git in it: git will not clone into it and perch cannot read it, so it used to wedge for good.
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'half.txt'), 'interrupted\n');
    await cloneInto(dir, remote);
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(existsSync(join(dir, 'half.txt'))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
