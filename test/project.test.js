import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { candidateCommands, COMMAND_ROLES, discoverProject } from '../src/project.js';
import { readJson } from '../src/store.js';
import { revision } from '../src/git.js';
import { commitAll, makeFixture, scriptedSystemOne } from './helpers.js';

const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });
const treeAt = async root => ({ root, revision: await revision(root), paths: ['package.json', 'src/clamp.js', 'test/clamp.test.js', 'pnpm-lock.yaml', '.github/workflows/ci.yml'] });

describe('project discovery', () => {
  it('finds the commands but does not decide what they are for', async () => {
    const root = await makeFixture();
    cleanups.push(root);
    const tree = await treeAt(root);
    // Reading the manifest says which commands exist. Nothing here says which is the suite.
    expect(await candidateCommands(tree)).toEqual(['pnpm test', 'node --test {file}']);

    const systemOne = scriptedSystemOne();
    const project = await discoverProject({ ...tree, out: join(root, '.perch'), systemOne });
    expect(project).toMatchObject({ revision: tree.revision, suite: 'pnpm test', single: 'node --test {file}', install: null, gates: [] });
    // Every command is put to the model, including the one there is no competition for.
    expect(systemOne.calls).toHaveLength(1);
    expect(Object.keys(systemOne.calls[0].questions)).toEqual(['role_0', 'role_1']);
    expect(Object.keys(systemOne.calls[0].questions.role_0.criteria)).toEqual(Object.keys(COMMAND_ROLES));
  });

  it('classifies every script and CI step by what it does, and caches the answers per commit', async () => {
    const root = await makeFixture();
    cleanups.push(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module',
      scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', release: 'npm publish' }, devDependencies: { vitest: '^2' } }) + '\n');
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await mkdir(join(root, '.github', 'workflows'), { recursive: true });
    await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'jobs:\n  test:\n    steps:\n      - run: pnpm install\n      - run: cargo clippy\n      - run: ${{ matrix.cmd }} test\n');
    await commitAll(root, 'tooling');
    const tree = await treeAt(root);

    const commands = await candidateCommands(tree);
    expect(commands).toContain('pnpm run lint');
    expect(commands).toContain('pnpm run release');
    expect(commands).toContain('cargo clippy');
    // A CI step that needs an Actions expression cannot be run outside Actions, so it is not a candidate.
    expect(commands.some(command => command.includes('${{'))).toBe(false);

    const systemOne = scriptedSystemOne();
    const out = join(root, '.perch');
    const project = await discoverProject({ ...tree, out, systemOne });
    expect(project.suite).toBe('pnpm test');
    expect(project.single).toBe('npx vitest run {file}');
    expect(project.install).toBe('pnpm install --frozen-lockfile');
    // Gates are whatever only reads the code. Publishing is not one, and neither is installing.
    expect(project.gates).toEqual(['pnpm run lint', 'pnpm run typecheck', 'cargo clippy']);
    expect(project.roles['pnpm run release']).toBe('none');
    expect(project.roles['pnpm install']).toBe('install');

    const [call] = systemOne.calls;
    expect(call.method).toBe('project');
    expect(call.state.manifests).toEqual(['package.json']);
    expect(call.state.workflows).toEqual(['.github/workflows/ci.yml']);
    expect(call.state.test_files).toEqual(['test/clamp.test.js']);
    expect(await readJson(join(out, 'projects', `${tree.revision}.json`), null)).toMatchObject({ single: 'npx vitest run {file}' });

    const again = scriptedSystemOne();
    expect((await discoverProject({ ...tree, out, systemOne: again })).single).toBe('npx vitest run {file}');
    expect(again.calls).toHaveLength(0);
  });

  it('finds commands for Python, Rust, and Go layouts from their paths', async () => {
    const root = await makeFixture();
    cleanups.push(root);
    const at = paths => candidateCommands({ root, revision: 'HEAD', paths });
    expect(await at(['pyproject.toml', 'uv.lock', 'tests/test_x.py'])).toEqual(['python3 -m pytest -q', 'python3 -m pytest -q {file}', 'uv sync']);
    expect(await at(['Cargo.toml', 'src/lib.rs'])).toEqual(['cargo test', 'cargo fetch', 'cargo clippy --all-targets -- -D warnings', 'cargo check --all-targets']);
    expect(await at(['go.mod', 'pkg/x_test.go'])).toEqual(['go test ./...', 'go test {dir}', 'go mod download', 'go vet ./...', 'go build ./...']);
    expect(await at(['README.md'])).toEqual([]);
  });
});
