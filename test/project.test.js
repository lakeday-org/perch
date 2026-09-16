import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listTree, revision } from '../src/git.js';
import { candidateCommands, discoverProject } from '../src/project.js';
import { readJson } from '../src/store.js';
import { commitAll, makeFixture, scriptedSystemOne } from './helpers.js';

const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

const treeAt = async root => { const rev = await revision(root); return { root, revision: rev, paths: (await listTree(root, rev)).map(item => item.path) }; };

describe('project discovery', () => {
  it('reads one unambiguous test command from the manifest without asking', async () => {
    const root = await makeFixture();
    cleanups.push(root);
    const tree = await treeAt(root);
    expect(await candidateCommands(tree)).toEqual({ suite: ['npm test'], single: ['node --test {file}'], install: [] });
    const systemOne = scriptedSystemOne();
    const project = await discoverProject({ ...tree, out: join(root, '.perch'), systemOne });
    expect(project).toMatchObject({ revision: tree.revision, suite: 'npm test', single: 'node --test {file}', install: null });
    expect(systemOne.calls).toHaveLength(0);
  });

  it('collects candidates from the manifest, lockfile, and CI, asks System One to choose, and caches the choice per commit', async () => {
    const root = await makeFixture();
    cleanups.push(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'vitest run && node --test test/' }, devDependencies: { vitest: '^2', jest: '^29' } }) + '\n');
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await mkdir(join(root, '.github', 'workflows'), { recursive: true });
    await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'jobs:\n  test:\n    steps:\n      - run: pnpm install\n      - run: pnpm test -- --coverage\n      - run: ${{ matrix.cmd }} test\n');
    await commitAll(root, 'tooling');
    const tree = await treeAt(root);
    const candidates = await candidateCommands(tree);
    expect(candidates.suite).toEqual(['pnpm test', 'pnpm test -- --coverage']);
    expect(candidates.single).toEqual(['npx vitest run {file}', 'npx jest {file}', 'node --test {file}']);
    expect(candidates.install).toEqual(['pnpm install --frozen-lockfile']);

    const systemOne = scriptedSystemOne({ project: { suite: 'pnpm test', single: 'npx vitest run {file}' } });
    const out = join(root, '.perch');
    const project = await discoverProject({ ...tree, out, systemOne });
    expect(project).toMatchObject({ suite: 'pnpm test', single: 'npx vitest run {file}', install: 'pnpm install --frozen-lockfile' });
    expect(systemOne.calls).toHaveLength(1);
    const [call] = systemOne.calls;
    expect(call.method).toBe('project');
    expect(Object.keys(call.questions)).toEqual(['suite', 'single']);
    expect(Object.keys(call.questions.single.criteria)).toEqual(candidates.single);
    expect(call.state.manifests).toEqual(['package.json']);
    expect(call.state.workflows).toEqual(['.github/workflows/ci.yml']);
    expect(call.state.test_files).toEqual(['test/clamp.test.js']);
    expect(await readJson(join(out, 'projects', `${tree.revision}.json`), null)).toMatchObject({ single: 'npx vitest run {file}' });

    const again = scriptedSystemOne();
    expect((await discoverProject({ ...tree, out, systemOne: again })).single).toBe('npx vitest run {file}');
    expect(again.calls).toHaveLength(0);
  });

  it('recognizes Python, Rust, and Go layouts from their paths', async () => {
    const root = await makeFixture();
    cleanups.push(root);
    const at = paths => candidateCommands({ root, revision: 'HEAD', paths });
    expect(await at(['pyproject.toml', 'uv.lock', 'tests/test_x.py'])).toEqual({ suite: ['python3 -m pytest -q'], single: ['python3 -m pytest -q {file}'], install: ['uv sync'] });
    expect(await at(['Cargo.toml', 'src/lib.rs'])).toEqual({ suite: ['cargo test'], single: ['cargo test'], install: ['cargo fetch'] });
    expect(await at(['go.mod', 'pkg/x_test.go'])).toEqual({ suite: ['go test ./...'], single: ['go test {dir}'], install: ['go mod download'] });
    expect(await at(['README.md'])).toEqual({ suite: [], single: [], install: [] });
  });
});
