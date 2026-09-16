import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { resolveTarget } from '../src/target.js';

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
