import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSourceAnalyzer, languageOf, sourceFile } from '../src/analysis.js';
import { analyzeTree, scanIdentity } from '../src/analyze.js';
import { ANALYSIS_PROFILE } from '../src/treesitter/types.ts';
import { identity } from '../src/store.js';
import { selectUnits } from '../src/units.js';
import { scanRepository } from '../src/scan.js';
import { revision } from '../src/git.js';
import { initRepo, scriptedSystemOne } from './helpers.js';

// Independent examples of dependency and output layouts, including languages without method analysis.
const excluded = [
  'vendor', 'node_modules', 'dist', 'target', 'build', 'coverage', 'out', 'third_party', 'third-party', 'thirdparty', '3rdparty',
  '.next', '.nuxt', '.output', '.svelte-kit', '.angular', '.parcel-cache', '.turbo', '.vite', '.npm', '.pnpm-store',
  'bower_components', 'jspm_packages', 'web_modules', 'storybook-static', '.docusaurus', '.nyc_output', '.cache',
  '.yarn/cache', '.yarn/unplugged', '.vitepress/cache', '.vitepress/dist',
  '.venv', 'venv', 'site-packages', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.eggs', 'htmlcov',
  '.gradle', '.bloop', '.metals', '.scala-build', '.cxx', '.externalNativeBuild',
  'CMakeFiles', 'cmake-build-debug', 'cmake-build-release', '_deps', 'bazel-bin', 'bazel-out', 'bazel-testlogs',
  '.build', 'Pods', 'DerivedData', 'Carthage/Build', 'Carthage/Checkouts',
  '.zig-cache', 'zig-cache', 'zig-out', '.dart_tool', '.pub-cache', '.pub',
  '.stack-work', 'dist-newstyle', '.cabal-sandbox', '_build', '.elixir_ls',
  'lua_modules', 'blib', '.precomp', 'renv/library', 'renv/staging', 'packrat/lib', 'packrat/lib-ext',
  '.cpcache', '.clj-kondo/.cache', '.godot', '.import', 'Godeps/_workspace',
];
const extensions = ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'pyi', 'rs', 'go', 'java', 'kt', 'kts', 'scala', 'sc',
  'groovy', 'gradle', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'cs', 'rb', 'rake', 'php', 'phtml', 'lua', 'swift', 'zig',
  'sol', 'sh', 'bash', 'dart', 'ex', 'hs', 'fs', 'R', 'pl', 'clj', 'md', 'yaml'];
const blob = path => ({ type: 'blob', path, sha: path });
const selected = (paths, each = 'file') => {
  const tree = paths.map(blob), files = new Map(paths.map(path => [path, "test('authored behavior', () => {});\n"]));
  return selectUnits({ name: 'selection', where: '**/*', each }, { tree, files }).map(unit => unit.path);
};

it('excludes generated and dependency directories regardless of language, depth, or rule kind', () => {
  for (const prefix of ['', 'apps/service/']) {
    const omitted = excluded.flatMap(dir => extensions.map(ext => `${prefix}${dir}/example.${ext}`));
    const kept = extensions.map(ext => `${prefix}src/example.${ext}`);
    expect(selected([...omitted, ...kept])).toEqual(kept);
    expect([...omitted, ...kept].map(blob).filter(sourceFile).map(item => item.path)).toEqual(kept.filter(languageOf));
    const tests = excluded.map(dir => `${prefix}${dir}/example.test.js`);
    expect(selected([...tests, `${prefix}test/example.test.js`], 'test')).toEqual([`${prefix}test/example.test.js`]);
  }
});

it('keeps authored scripts, libraries, configuration, and similarly named paths', () => {
  const paths = ['bin/run.sh', 'lib/code.rb', 'packages/app/index.ts', 'deps/adapter.ex', 'cache/handler.py', 'public/client.js',
    'Library/code.cs', 'env/settings.py', 'obj/reader.cpp', 'artifacts/reader.sol', 'src/building/code.js', 'outcome/model.rs',
    'third_party_api/client.go', '.next-notes/readme.md', 'src/node_modules.js', 'build', 'out',
    '.yarn/plugins/plugin.js', '.yarn/releases/yarn.cjs', '.vitepress/config.ts', 'renv/activate.R', '.cargo/config.toml'];
  expect(selected(paths)).toEqual(paths);
  expect(selected(['huge.py', 'huge.md'])).toEqual(['huge.py', 'huge.md']);
  expect(sourceFile({ ...blob('huge.py'), size: 16 * 1024 * 1024 })).toBe(true);
});

const projects = [
  ['App.csproj', ['bin', 'obj', 'Bin', 'Obj']], ['App.fsproj', ['bin', 'obj']], ['App.vbproj', ['bin', 'obj']],
  ['mix.exs', ['deps']], ['rebar.config', ['deps']],
  ['hardhat.config.ts', ['cache', 'artifacts']], ['hardhat.config.js', ['cache', 'artifacts']],
  ['foundry.toml', ['cache', 'broadcast']],
  ['ProjectSettings/ProjectVersion.txt', ['Library', 'Temp', 'Obj', 'Logs', 'UserSettings', 'Builds']],
  ['Game.uproject', ['Binaries', 'Intermediate', 'Saved']],
];
it('uses project markers to exclude ambiguous output names only in the owning project', () => {
  for (const prefix of ['', 'apps/service/']) for (const [marker, dirs] of projects) {
    const generated = dirs.map(dir => `${prefix}${dir}/generated.js`);
    const kept = [prefix + marker, `${prefix}src/authored.js`, ...dirs.map(dir => `${prefix}tools/${dir}/authored.js`),
      ...dirs.map(dir => `other/${dir}/authored.js`)];
    expect(selected([...generated, ...kept]), marker).toEqual(kept);
  }
  expect(selected(['tools/env/pyvenv.cfg', 'tools/env/lib/code.py', 'tools/env/bin/run.py', 'env/settings.py'])).toEqual(['env/settings.py']);
});

it('invalidates analysis cached before the exclusion policy changed', () => {
  const options = { revision: 'same-commit', paths: [] };
  expect(scanIdentity(options)).not.toBe(identity('scan', ANALYSIS_PROFILE, options.revision, []));
});

it('does not treat the repository itself as a generated directory', () => {
  expect(selected(['pyvenv.cfg', 'src/app.py', 'bin/run.sh'])).toEqual(['pyvenv.cfg', 'src/app.py', 'bin/run.sh']);
});

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('keeps excluded code out of parsing, method and file checks, searches, tests, and prose context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perch-exclusions-')); roots.push(root);
  const sources = {
    'src/app.ts': 'export function read() { return 1; }',
    'src/app.py': 'def read():\n    return 1\n',
    'src/app.rs': 'pub fn read() -> i32 { 1 }',
    'src/App.java': 'class App { int read() { return 1; } }',
    'src/app.cpp': 'int read() { return 1; }',
    'bin/run.sh': 'echo authored',
    'test/app.test.js': "test('authored behavior', () => {});",
    'README.md': 'An authored guide.',
    'service/App.csproj': '<Project />',
    '.venv/example.py': 'EXCLUDED_DEPENDENCY_TEXT',
    'out/example.ts': 'EXCLUDED_DEPENDENCY_TEXT',
    'third_party/example.cpp': 'EXCLUDED_DEPENDENCY_TEXT',
    '.next/example.js': "test('EXCLUDED_DEPENDENCY_TEXT', () => {});",
    'service/obj/example.cs': 'EXCLUDED_DEPENDENCY_TEXT',
    'perch.yaml': 'scan_types: [lint]\nrules:\n' +
      '  - name: files\n    where: "**/*"\n    ensure: Source is authored.\n' +
      '  - name: tests\n    where: "**/*.js"\n    each: test\n    ensure: Tests assert behavior.\n' +
      '  - name: methods\n    where: "src/**"\n    each: method\n    ensure: Methods return a value.\n' +
      '  - name: search\n    where: "**/*"\n    ensure_absent: missing documentation\n' +
      '  - name: context\n    where: README.md\n    sees: neighbors\n    ensure: The guide describes the neighboring files.\n',
  };
  for (const [path, text] of Object.entries(sources)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await initRepo(root);
  const analyzer = createSourceAnalyzer(), systemOne = scriptedSystemOne();
  const options = { root, revision: await revision(root), out: join(root, '.perch'), analyzer };
  const scan = await analyzeTree(options);
  expect(scan.coverage.parse_failures).toBe(0);
  expect(scan.files.map(file => file.path).sort()).toEqual(Object.keys(sources).filter(path => /^(src|bin|test)\//.test(path)).sort());
  const run = await scanRepository({ ...options, systemOne });
  expect(run.status).toBe('complete');
  expect(run.failed).toEqual([]);
  expect(run.coverage.find(row => row.name === 'methods').units).toBe(5);
  expect(run.coverage.find(row => row.name === 'tests').units).toBe(1);
  const expectedFiles = Object.keys(sources).filter(path => !sources[path].includes('EXCLUDED_DEPENDENCY_TEXT') && path !== 'perch.yaml');
  expect(run.coverage.find(row => row.name === 'files').units).toBe(expectedFiles.length);
  expect(run.coverage.find(row => row.name === 'search').units).toBe(expectedFiles.length);
  expect(systemOne.calls.some(call => call.questions.context)).toBe(true);
  expect(systemOne.calls.some(call => call.questions.methods)).toBe(true);
  expect(JSON.stringify(systemOne.calls)).not.toContain('EXCLUDED_DEPENDENCY_TEXT');
});
