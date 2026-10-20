import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSourceAnalyzer, languageOf, sourceFile } from '../src/analysis.js';
import { analyzeTree, scanIdentity } from '../src/analyze.js';
import { PARSE_VERSION } from '../src/treesitter/types.ts';
import { identity } from '../src/store.js';
import { selectUnits } from '../src/units.js';
import { scanRepository } from '../src/scan.js';
import { attributeRules, createFileSelector, generatedText } from '../src/exclusions.js';
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
const selected = paths => {
  const tree = paths.map(blob), files = new Map(paths.map(path => [path, "test('authored behavior', () => {});\n"]));
  return selectUnits({ name: 'selection', where: '**/*', each: 'file' }, { tree, files }).map(unit => unit.path);
};

it('excludes generated and dependency directories regardless of language, depth, or rule kind', () => {
  for (const prefix of ['', 'apps/service/']) {
    const omitted = excluded.flatMap(dir => extensions.map(ext => `${prefix}${dir}/example.${ext}`));
    const kept = extensions.map(ext => `${prefix}src/example.${ext}`);
    expect(selected([...omitted, ...kept])).toEqual(kept);
    expect([...omitted, ...kept].map(blob).filter(sourceFile).map(item => item.path)).toEqual(kept.filter(languageOf));
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
  expect(scanIdentity(options)).not.toBe(identity('scan', PARSE_VERSION, options.revision, []));
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

it('reads a file as generated when its text says a tool wrote it, as GitHub does', () => {
  const bundle = `!function(e){var t={};function n(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};return e[r].call(o.exports,o,o.exports,n),o.l=!0,o.exports}}([]);\n`;
  expect(generatedText('public/js/app.js', bundle.repeat(3))).toBe('minified');
  expect(generatedText('public/css/app.css', `.a{color:red}${'.b{margin:0;padding:0;border:0}'.repeat(10)}\n`)).toBe('minified');
  expect(generatedText('src/app.js', 'export function read() {\n  return 1;\n}\n//# sourceMappingURL=app.js.map\n')).toBe('source map');
  expect(generatedText('api/types.go', 'package api\n\n// Code generated by protoc-gen-go. DO NOT EDIT.\n')).toBe('generated');
  expect(generatedText('src/__generated__/query.ts', '/**\n * @generated SignedSource<<abc>>\n */\nexport const query = 1;\n')).toBe('generated');
  expect(generatedText('gen/user_pb2.py', '# Generated by the protocol buffer compiler.  DO NOT EDIT!\n')).toBe('generated');
  // Authored code that talks about generating things, or has one long line among short ones, is read.
  expect(generatedText('src/codegen.js', '// Writes code generated from the schema.\nexport function generate() {\n  return "DO NOT EDIT is written by the generator";\n}\n')).toBeNull();
  expect(generatedText('src/app.js', `const message = "${'x'.repeat(200)}";\nexport function read() {\n  return message;\n}\n`)).toBeNull();
  expect(generatedText('src/app.py', `x = "${'y'.repeat(400)}"\n`)).toBeNull();
});

it('follows the repository\'s .gitattributes for generated and vendored paths, over the defaults either way', async () => {
  const texts = {
    '.gitattributes': '# assets\npublic/js/** linguist-generated\n*.pb.ts linguist-generated=true\nvendor/ours/** -linguist-vendored\n',
    'packages/app/.gitattributes': 'fixtures/** linguist-vendored\nfixtures/keep.js linguist-vendored=false\n',
  };
  const paths = [...Object.keys(texts), 'public/js/app.js', 'src/api.pb.ts', 'src/app.ts', 'vendor/ours/lib.js', 'vendor/theirs/lib.js',
    'packages/app/fixtures/data.js', 'packages/app/fixtures/keep.js', 'fixtures/data.js'];
  const tree = paths.map(path => ({ type: 'blob', path, sha: path }));
  const attributes = await attributeRules(tree, item => texts[item.path]);
  expect(tree.filter(createFileSelector(tree, attributes)).map(item => item.path).filter(path => !path.endsWith('.gitattributes')))
    .toEqual(['src/app.ts', 'vendor/ours/lib.js', 'packages/app/fixtures/keep.js', 'fixtures/data.js']);
});

it('keeps minified bundles and generator output out of parsing, rules, and searches, unless .gitattributes says they are authored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perch-generated-')); roots.push(root);
  const minified = `function GENERATED_TEXT(e){return e&&e.__esModule?e:{default:e}}${'var a=function(b){return b+1};'.repeat(8)}\n`;
  const sources = {
    'src/app.js': 'export function read() {\n  return 1;\n}\n',
    'public/js/app.js': minified.repeat(4),
    'public/js/kept.js': minified.replaceAll('GENERATED_TEXT', 'AUTHORED_BUNDLE').repeat(4),
    'api/types.go': 'package api\n\n// Code generated by stringer. DO NOT EDIT.\n\nfunc GENERATED_TEXT() int { return 1 }\n',
    'src/schema.js': 'export function GENERATED_TEXT() {\n  return 1;\n}\n',
    '.gitattributes': 'src/schema.js linguist-generated\npublic/js/kept.js -linguist-generated\n',
    'perch.yaml': 'scan_types: [lint]\nrules:\n  - name: files\n    where: "**/*.{js,go}"\n    ensure: Source is authored.\n' +
      '  - name: search\n    where: "**/*.{js,go}"\n    ensure_absent: missing documentation\n',
  };
  for (const [path, text] of Object.entries(sources)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await initRepo(root);
  const analyzer = createSourceAnalyzer(), systemOne = scriptedSystemOne();
  const options = { root, revision: await revision(root), out: join(root, '.perch'), analyzer };
  const scan = await analyzeTree(options);
  expect(scan.files.map(file => file.path).sort()).toEqual(['public/js/kept.js', 'src/app.js']);
  expect(scan.coverage.generated).toBe(2);
  const run = await scanRepository({ ...options, systemOne });
  expect(run.status).toBe('complete');
  expect(run.coverage.find(row => row.name === 'files').units).toBe(2);
  expect(run.coverage.find(row => row.name === 'search').units).toBe(2);
  const asked = JSON.stringify(systemOne.calls);
  expect(asked).not.toContain('GENERATED_TEXT');
  expect(asked).toContain('AUTHORED_BUNDLE');
});
