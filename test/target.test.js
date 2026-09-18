import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseGithub, resolveTarget } from '../src/target.js';

const execFileAsync = promisify(execFile);
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function runGit(args, cwd) {
  await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd });
}

/** A repository with a directory in it, which is all a scope needs to be read off a path. */
async function repo() {
  const root = await mkdtemp(join(process.cwd(), '.target-test-'));
  cleanups.push(root);
  await runGit(['init', '-q', root], root);
  await runGit(['config', 'user.name', 'Fixture'], root);
  await runGit(['config', 'user.email', 'fixture@example.com'], root);
  await mkdir(join(root, 'docs', 'deep'), { recursive: true });
  await writeFile(join(root, 'docs', 'index.md'), 'fixture\n');
  await writeFile(join(root, 'README.md'), 'fixture\n');
  await runGit(['add', '.'], root);
  await runGit(['commit', '-q', '-m', 'fixture'], root);
  return root;
}

describe('resolveTarget', () => {
  it('reads the whole repository when given none of it', async () => {
    const root = await repo();
    const resolved = await resolveTarget(root, {});
    // No scope is the whole tree. A scan narrows on --paths or --since from here, and on nothing otherwise.
    expect(resolved.scope).toBe(null);
    expect(resolved.kind).toBe('local');
  });

  it('keeps the directory it was given as the scope', async () => {
    const root = await repo();
    // The root has to be the repository, since perch reads a commit and a call graph spans files. The part under it is the
    // scope, which is what `perch scan docs/` meant and did not get: it read every method in the repository and billed for it.
    expect((await resolveTarget(join(root, 'docs'), {})).scope).toBe('docs');
    expect((await resolveTarget(join(root, 'docs') + '/', {})).scope).toBe('docs');
    expect((await resolveTarget(join(root, 'docs', 'index.md'), {})).scope).toBe('docs/index.md');
    // Always with forward slashes, since that is what a path in a commit and in --paths looks like.
    expect((await resolveTarget(join(root, 'docs', 'deep'), {})).scope).toBe('docs/deep');
  });

  it('refuses a path that is not there, naming perch rather than git', async () => {
    const root = await repo();
    await expect(resolveTarget(join(root, 'nope'), {})).rejects.toThrow(/is not a file or directory/);
  });

  it('refuses a path in no repository, naming perch rather than git', async () => {
    // tmpdir is outside any checkout, so git has nothing to walk up to.
    const loose = await mkdtemp(join(tmpdir(), 'perch-loose-'));
    cleanups.push(loose);
    await expect(resolveTarget(loose, {})).rejects.toThrow(/not in a git repository/);
  });
});

describe('parseGithub', () => {
  it('reads an origin url, and nothing else', async () => {
    expect(parseGithub('https://github.com/lakeday-org/perch.git')).toEqual({ owner: 'lakeday-org', repo: 'perch' });
    expect(parseGithub('git@github.com:lakeday-org/perch.git')).toEqual({ owner: 'lakeday-org', repo: 'perch' });
    // owner/repo was a target to clone once. It is a path now, so it must not read as a repository somewhere else.
    expect(parseGithub('lakeday-org/perch')).toBe(null);
    expect(parseGithub('docs/index.md')).toBe(null);
    expect(parseGithub('')).toBe(null);
  });
});
