/**
 * What a coverage run is about: the code the repository's own test frameworks run and measure. A file no framework would run or
 * measure, such as a release script, an editor plugin or a CI action, is left out, since no test of this suite could cover it.
 *
 * A JavaScript framework's config is loaded the way the framework loads it, with the repository's own installed copy, so the
 * tests are the ones it would run and the coverage globs are the ones it would apply. Python's are read from the files pytest and
 * coverage.py read. Other languages have no config to read for this: their tests cover the build module the tests sit in.
 */
import { execFile } from 'node:child_process';
import { createRequire as requireFrom } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { resolveModule } from './graph.js';

const JS = new Set(['javascript', 'typescript', 'tsx']);
/** Languages whose tests reach code through imports perch resolves, so the code they cover is followed from the tests. */
const FOLLOWED = new Set([...JS, 'python']);

/**
 * The build files that bound a language's module, and whether a test covers the nearest one (a Go module, a crate, a Gradle
 * module) or the outermost (a CMake project, a .NET solution, a gem), where tests sit in a module of their own.
 */
const MODULES = [
  { languages: ['go'], files: [/^go\.mod$/], nearest: true, tests: /_test\.go$/ },
  { languages: ['rust'], files: [/^Cargo\.toml$/], nearest: true, built: 'src/', tests: /^tests\// },
  { languages: ['java', 'kotlin', 'scala', 'groovy'], files: [/^build\.gradle(\.kts)?$/, /^pom\.xml$/, /^build\.sbt$/], nearest: true, built: 'src/main/',
    tests: /^src\/(?:test|testFixtures|integrationTest|\w+Test)\// },
  { languages: ['swift'], files: [/^Package\.swift$/, /\.xcodeproj$/], nearest: true },
  { languages: ['dart'], files: [/^pubspec\.yaml$/], nearest: true },
  { languages: ['elixir'], files: [/^mix\.exs$/], nearest: true },
  { languages: ['c', 'cpp'], files: [/^CMakeLists\.txt$/, /^meson\.build$/, /^Makefile$/], nearest: false },
  { languages: ['csharp', 'fsharp'], files: [/\.sln$/, /\.[cf]sproj$/], nearest: false },
  { languages: ['ruby'], files: [/^Gemfile$/, /\.gemspec$/], nearest: false },
  { languages: ['php'], files: [/^composer\.json$/, /^phpunit\.xml(\.dist)?$/], nearest: false },
];

/**
 * Test code that holds no test, by each tool's own rule rather than by its name: what Gradle, Maven, sbt, Cargo and Go build only
 * for tests (`tests` above, from the module's build file), pytest's conftest.py and its testpaths, and a JavaScript or Python
 * module only test code imports. Each is marked `test`, as a file of tests is.
 */
/** The headers of C and C++ test frameworks. */
const NATIVE_TEST_HEADERS = /^(?:gtest|gmock|catch2?|doctest|boost\/test|CppUTest|cxxtest)\/|^(?:gtest|gmock|catch|doctest)\.h(?:pp)?$/;

/** Languages whose imports and includes name files, so which code uses a module is known. */
const GROUPED = new Set([...FOLLOWED, 'c', 'cpp']);

/** The test runners, assertion and mocking libraries a test helper is written with. */
const TEST_LIBRARIES = /^(?:vitest|jest|@jest\/[\w-]+|mocha|chai|sinon|node:test|ava|tap|uvu|@testing-library\/[\w-]+|supertest|nock|msw|pytest|_pytest|unittest(?:\.mock)?|mock|hypothesis|factory|freezegun|responses)(?:$|[/.])/;

export async function markTestSupport({ root, paths, files }) {
  const pathSet = new Set(paths);
  const byPath = new Map(files.map(file => [file.path, file]));
  const isTest = file => file.test || file.methods.some(method => method.test);
  for (const module of MODULES.filter(item => item.tests)) {
    const manifests = paths.filter(path => module.files.some(pattern => pattern.test(path.split('/').at(-1)))).map(dirOf);
    for (const file of files.filter(item => module.languages.includes(item.language) && !isTest(item))) {
      const own = manifests.filter(dir => under(dir, file.path)).sort(byDepth).at(-1);
      if (own !== undefined && module.tests.test(own ? file.path.slice(own.length + 1) : file.path)) file.test = true;
    }
  }
  const python = files.filter(file => file.language === 'python');
  if (python.some(isTest)) {
    const { testpaths } = await pythonFramework({ root, paths });
    for (const file of python) {
      if (file.path.split('/').at(-1) === 'conftest.py' || (testpaths && testpaths.some(dir => under(dir.replace(/\/$/, ''), file.path)))) file.test = true;
    }
  }
  // A module that uses a test library and that only test code imports is test code: a test/helpers.js that builds stubs with
  // sinon, a tests/factories.py on pytest. Either alone is not: a library's own module may be imported only by its tests, and
  // a pytest plugin it ships uses pytest.
  const testing = file => (file.imports ?? []).some(item => TEST_LIBRARIES.test(item.module ?? ''));
  // C and C++ include a test framework's header only to write tests with it: gtest-all.cc, a fixture header. Production code may
  // include gtest_prod.h, for FRIEND_TEST, and nothing else of it.
  for (const file of files.filter(item => (item.language === 'c' || item.language === 'cpp') && !item.test)) {
    if ((file.imports ?? []).some(item => NATIVE_TEST_HEADERS.test(item.module ?? '') && !/gtest_prod\.h$/.test(item.module))) file.test = true;
  }
  const importers = new Map();
  for (const file of files.filter(item => GROUPED.has(item.language))) {
    for (const item of file.imports ?? []) {
      const target = resolveModule(file.path, item.module, file.language, pathSet);
      if (target && target !== file.path && byPath.has(target)) importers.set(target, [...(importers.get(target) ?? []), file]);
    }
  }
  const onlyTests = file => (importers.get(file.path) ?? []).length > 0 && importers.get(file.path).every(item => item.test);
  for (let changed = true; changed;) {
    changed = false;
    for (const [path] of importers) {
      const file = byPath.get(path);
      if (!file.test && !isTest(file) && testing(file) && onlyTests(file)) { file.test = true; changed = true; }
    }
  }
  // A directory of test files and the code only they use, a test/ beside src/, is test code throughout, and so is a directory of
  // modules only tests import inside one, a test/helpers/. Code only the tests use is a module only tests import, or, beside the
  // tests, one nothing imports, which a test runner loads by its config or a build compiles with them. A directory holding any
  // module that other code imports is not, which keeps a src/ with tests beside its modules what it is.
  const byDir = new Map();
  for (const file of files.filter(item => GROUPED.has(item.language))) byDir.set(dirOf(file.path), [...(byDir.get(dirOf(file.path)) ?? []), file]);
  const testDirs = new Set();
  for (const dir of [...byDir.keys()].sort(byDepth)) {
    const held = byDir.get(dir);
    const parent = [...testDirs].some(outer => outer !== dir && under(outer, dir) && outer !== '');
    const holdsTests = held.some(file => file.test);
    if (!holdsTests && !parent) continue;
    // Nothing importing a module says it is test code only beside the tests themselves: under them it is as likely an entry point.
    if (!held.every(file => file.test || onlyTests(file) || (holdsTests && !importers.has(file.path)))) continue;
    testDirs.add(dir);
    for (const file of held) file.test = true;
  }
}

/** Directories a project keeps code no test of its suite covers in: tools, benchmarks, examples, scripts, docs. */
const NOT_BUILT = /^(?:.*\/)?(?:tools?|bench(?:es|marks?)?|examples?|samples?|scripts|docs?)\//;

/**
 * A file the git tree lists, read from the working tree. One the working tree has since lost is empty, as a file with nothing in
 * it is to the settings read from it; any other failure to read it is an error, not an empty file.
 */
const readListed = (root, path) => readFile(join(root, path), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const toPosix = path => path.split(sep).join('/');
const inside = (root, path) => { const rel = relative(root, path); return rel && !rel.startsWith('..') && !isAbsolute(rel) ? toPosix(rel) : null; };
const dirOf = path => (path.includes('/') ? posix.dirname(path) : '');
const under = (dir, path) => dir === '' || path.startsWith(`${dir}/`);
const glob = (pattern, path) => posix.matchesGlob(path, pattern.replace(/^\.\//, ''));

function run(command, args, { cwd, input = null, timeout = 120_000 }) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd, timeout, maxBuffer: 256 * 1024 * 1024 },
      // The line naming the error, not the command or the stack: "Cannot find module 'vitest/package.json'" says what to do.
      (error, stdout, stderr) => (error ? reject(new Error(stderr.split('\n').map(line => line.trim()).find(line => /^(\w*Error)( \[\w+\])?: /.test(line)) ?? error.message.split('\n')[0])) : resolve(stdout)));
    // Closed either way: a config that reads stdin would otherwise wait on it until the timeout.
    child.stdin.end(input ?? undefined);
  });
}

/**
 * Loads a Vitest config with the repository's own Vitest and asks it which test files each project would run, and what its
 * coverage settings are. Printed on the last line, after a marker, since a config may print anything.
 */
const VITEST = String.raw`
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [config] = process.argv.slice(1);
const out = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
console.log = console.info = console.warn = console.debug = out;
const require = createRequire(join(dirname(config), 'perch.cjs'));
const manifest = require.resolve('vitest/package.json');
const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
const entry = pkg.exports['./node'];
const file = typeof entry === 'string' ? entry : entry.import?.default ?? entry.import ?? entry.default;
const { createVitest } = await import(pathToFileURL(join(dirname(manifest), file)).href);
const vitest = await createVitest('test', { ...(config.endsWith('package.json') ? { root: dirname(config) } : { config }), watch: false }, {}, {});
const projects = vitest.projects?.length ? vitest.projects : [vitest.getRootProject?.() ?? vitest.getCoreWorkspaceProject?.()].filter(Boolean);
const tests = new Set();
for (const project of projects) {
  const found = await project.globTestFiles();
  for (const path of Array.isArray(found) ? found : [...(found.testFiles ?? []), ...(found.typecheckTestFiles ?? [])]) tests.add(path);
}
const coverage = vitest.config.coverage ?? {};
const result = { version: pkg.version, root: vitest.config.root, tests: [...tests],
  coverage: { include: coverage.include ?? null, exclude: coverage.exclude ?? [], all: coverage.all ?? null } };
await vitest.close();
// Exit once the pipe has taken all of it: exiting straight away cut a large result off at 64 KB.
process.stdout.write('\n\u0000perch' + JSON.stringify(result) + '\n', () => process.exit(0));
`;

const parseMarked = stdout => {
  const at = stdout.lastIndexOf('\u0000perch');
  if (at === -1) throw new Error('printed no result');
  return JSON.parse(stdout.slice(at + 6).trim());
};

/** Configs nearest the root first, so one whose projects already run a directory's tests is the one that speaks for them. */
const byDepth = (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b);

async function loadVitest({ root, config, node }) {
  // Vitest names files by their real path, /private/var/... on macOS where a temporary directory is /var/....
  root = await realpath(root);
  const loaded = parseMarked(await run(node, ['--input-type=module', '-e', VITEST, join(root, config)], { cwd: join(root, dirOf(config)) }));
  const base = loaded.root;
  const tests = loaded.tests.map(path => inside(root, path)).filter(Boolean);
  // Coverage globs are relative to the project root. Vitest's default include, everything, says nothing about which files.
  const prefix = inside(root, base) ?? '';
  const rooted = patterns => (patterns ?? []).map(pattern => (prefix && !pattern.startsWith('**') ? `${prefix}/${pattern.replace(/^\.\//, '')}` : pattern));
  const include = loaded.coverage.include && !(loaded.coverage.include.length === 1 && loaded.coverage.include[0] === '**') ? rooted(loaded.coverage.include) : null;
  return { name: 'Vitest', version: loaded.version, config, tests, include, exclude: rooted(loaded.coverage.exclude) };
}

async function loadJest({ root, config, node, paths }) {
  root = await realpath(root);
  // Jest runs from its package, with a config file named by --config: one kept under scripts/ still runs from the package root.
  const own = config.endsWith('package.json');
  const cwd = join(root, own ? dirOf(config) : [...paths].filter(path => /(^|\/)package\.json$/.test(path) && under(dirOf(path), config)).map(dirOf).sort(byDepth).at(-1) ?? '');
  const named = own ? [] : ['--config', join(root, config)];
  const manifest = requireFrom(join(cwd, 'perch.cjs')).resolve('jest/package.json');
  const bin = join(dirname(manifest), 'bin', 'jest.js');
  const version = JSON.parse(await readFile(manifest, 'utf8')).version;
  const shown = JSON.parse(await run(node, [bin, ...named, '--showConfig'], { cwd }));
  const listed = (await run(node, [bin, ...named, '--listTests'], { cwd })).split('\n').map(line => line.trim()).filter(Boolean);
  const tests = listed.map(path => inside(root, path)).filter(Boolean);
  const configs = shown.configs ?? [];
  const include = configs.flatMap(item => (item.collectCoverageFrom ?? []).map(pattern => {
    const prefix = inside(root, item.rootDir) ?? '';
    return pattern.startsWith('!') ? null : prefix ? `${prefix}/${pattern.replace(/^\.\//, '')}` : pattern;
  })).filter(Boolean);
  const negated = configs.flatMap(item => (item.collectCoverageFrom ?? []).filter(pattern => pattern.startsWith('!')).map(pattern => {
    const prefix = inside(root, item.rootDir) ?? '';
    const bare = pattern.slice(1).replace(/^\.\//, '');
    return prefix ? `${prefix}/${bare}` : bare;
  }));
  const ignore = configs.flatMap(item => item.coveragePathIgnorePatterns ?? []).map(source => new RegExp(source));
  return { name: 'Jest', version, config, tests, include: include.length ? include : null, exclude: negated, ignore: path => ignore.some(pattern => pattern.test(join(root, path))) };
}

/** The JavaScript test frameworks a config names, loaded. One that cannot be loaded is reported, and its tests fall back. */
async function javascriptFrameworks({ root, paths: all, node, ignored, debug }) {
  // A config under a path perch.yaml ignores, such as a fixture app's, is not this repository's suite.
  const paths = all.filter(path => !ignored(path));
  const vitest = paths.filter(path => /(^|\/)vitest\.(config|workspace)\.[cm]?[jt]s$/.test(path)).sort(byDepth);
  const jest = paths.filter(path => /(^|\/)jest\.config\.[cm]?[jt]s(on)?$/.test(path)).sort(byDepth);
  // A package.json with a "jest" key is a config too, as is a vite.config with a test block.
  for (const path of paths.filter(path => /(^|\/)package\.json$/.test(path))) {
    const text = await readListed(root, path);
    if (/"jest"\s*:\s*\{/.test(text) && !jest.some(config => dirOf(config) === dirOf(path))) jest.push(path);
  }
  for (const path of paths.filter(path => /(^|\/)vite\.config\.[cm]?[jt]s$/.test(path))) {
    const text = await readListed(root, path);
    if (/\btest\s*:/.test(text) && !vitest.some(config => dirOf(config) === dirOf(path))) vitest.push(path);
  }
  // A package that depends on Vitest or Jest without a config runs it with its defaults, from the package's directory.
  for (const path of paths.filter(path => /(^|\/)package\.json$/.test(path))) {
    const text = await readListed(root, path);
    // A config anywhere in the package, such as scripts/jest/jest.config.js, is the one its test script names.
    const dir = dirOf(path), within = config => under(dir, config);
    if (vitest.some(within) || jest.some(within)) continue;
    if (/"vitest"\s*:/.test(text)) vitest.push(path);
    else if (/"jest"\s*:/.test(text)) jest.push(path);
  }
  const frameworks = [];
  const claimed = new Set();
  for (const [configs, load, name] of [[vitest.sort(byDepth), loadVitest, 'Vitest'], [jest.sort(byDepth), loadJest, 'Jest']]) {
    for (const config of configs) {
      // A nested config whose tests a loaded one already runs is one of its projects.
      if ([...claimed].some(path => under(dirOf(config), path))) continue;
      try {
        const framework = await load({ root, config, node, paths });
        debug(`${name} ${framework.version} (${config}) runs ${framework.tests.length} test files`);
        for (const path of framework.tests) claimed.add(path);
        frameworks.push(framework);
      } catch (error) {
        frameworks.push({ name, config, error: error.message, tests: null });
      }
    }
  }
  return frameworks;
}

/** One value from an ini section or a TOML table, as a list: `testpaths = tests docs` or `testpaths = ["tests", "docs"]`. */
function setting(text, sections, key) {
  for (const section of sections) {
    const at = text.search(new RegExp(`^\\[${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*$`, 'm'));
    if (at === -1) continue;
    const body = text.slice(at).split('\n').slice(1);
    const end = body.findIndex(line => /^\[/.test(line));
    const lines = end === -1 ? body : body.slice(0, end);
    const start = lines.findIndex(line => new RegExp(`^${key}\\s*=`).test(line));
    if (start === -1) continue;
    let value = lines[start].replace(new RegExp(`^${key}\\s*=\\s*`), '');
    for (let index = start + 1; index < lines.length && (/^\s+\S/.test(lines[index]) || (value.includes('[') && !value.includes(']'))); index++) value += `\n${lines[index]}`;
    const listed = value.includes('[') ? [...value.matchAll(/["']([^"']+)["']/g)].map(match => match[1]) : value.split(/[\s,]+/);
    return listed.map(item => item.trim()).filter(Boolean);
  }
  return null;
}

/** pytest's and coverage.py's settings from whichever of their files the repository has, read as they read them. */
async function pythonFramework({ root, paths }) {
  const files = ['pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg', '.coveragerc'].filter(name => paths.includes(name));
  const read = Object.fromEntries(await Promise.all(files.map(async name => [name, await readListed(root, name)])));
  const find = (key, places) => { for (const [name, sections] of places) if (read[name]) { const found = setting(read[name], sections, key); if (found) return found; } return null; };
  const pytest = [['pytest.ini', ['pytest']], ['pyproject.toml', ['tool.pytest.ini_options']], ['tox.ini', ['pytest']], ['setup.cfg', ['tool:pytest']]];
  const coverage = [['.coveragerc', ['run']], ['pyproject.toml', ['tool.coverage.run']], ['setup.cfg', ['coverage:run']], ['tox.ini', ['coverage:run']]];
  const config = pytest.find(([name, sections]) => read[name] && sections.some(section => read[name].includes(`[${section}]`)))?.[0] ?? null;
  return { name: 'pytest', config, testpaths: find('testpaths', pytest), python_files: find('python_files', pytest) ?? ['test_*.py', '*_test.py'],
    source: find('source', coverage), omit: find('omit', coverage) ?? [] };
}

/**
 * The scope of a run: which tests the frameworks run, and which source files they cover. Null when the repository has no tests
 * any framework would run, in which case nothing is narrowed.
 */
export async function frameworkScope({ root, tree, scan, graph, node = process.execPath, ignored = () => false, debug = () => {} }) {
  const paths = tree.filter(item => item.type === 'blob').map(item => item.path);
  const pathSet = new Set(paths);
  const byPath = new Map(scan.files.map(file => [file.path, file]));
  await markTestSupport({ root, paths, files: scan.files });
  // What a framework runs is a file with test cases in it; test code holding none, a helper or a benchmark, is left out of both.
  const holdsTests = file => file.methods.some(method => method.test);
  const found = scan.files.filter(holdsTests);
  const frameworks = [];
  const tests = new Set(), sources = new Set();

  // JavaScript: the tests a loaded config runs, or, with no config that loads, every test the parser found.
  const js = await javascriptFrameworks({ root, paths, node, ignored, debug });
  frameworks.push(...js);
  const loaded = js.filter(framework => framework.tests);
  const jsTests = loaded.length ? loaded.flatMap(framework => framework.tests) : found.filter(file => JS.has(file.language)).map(file => file.path);
  if (!js.length && jsTests.length) frameworks.push({ name: 'JavaScript tests', config: null, tests: jsTests });
  for (const path of jsTests) if (byPath.has(path)) tests.add(path);

  // Python: the tests under testpaths named as python_files, or every test the parser found.
  const pyFound = found.filter(file => file.language === 'python').map(file => file.path);
  let python = null;
  if (pyFound.length) {
    python = await pythonFramework({ root, paths });
    const named = path => python.python_files.some(pattern => glob(pattern, path.split('/').at(-1)));
    const kept = pyFound.filter(path => (!python.testpaths || python.testpaths.some(dir => under(dir.replace(/\/$/, ''), path))) && (named(path) || !python.testpaths));
    for (const path of kept) tests.add(path);
    python.tests = kept;
    frameworks.push(python);
  }

  // Everything else: the tests the parser found, covering the build module they sit in.
  const moduleRoots = new Map();
  for (const module of MODULES) {
    const mine = found.filter(file => module.languages.includes(file.language));
    if (!mine.length) continue;
    const manifests = paths.filter(path => module.files.some(pattern => pattern.test(path.split('/').at(-1)))).map(dirOf)
      .concat(paths.filter(path => /\.xcodeproj\/project\.pbxproj$/.test(path) && module.languages.includes('swift')).map(path => dirOf(dirOf(path))));
    const roots = new Set();
    for (const file of mine) {
      tests.add(file.path);
      const holding = manifests.filter(dir => under(dir, file.path)).sort(byDepth);
      roots.add((module.nearest ? holding.at(-1) : holding[0]) ?? '');
    }
    // A source file is the module's when its own nearest build file is one the tests are in: a separate tool's pom.xml, or a
    // Gradle module with no tests, has a nearest build file of its own.
    const ownRoot = path => { const holding = manifests.filter(dir => under(dir, path)).sort(byDepth); return (module.nearest ? holding.at(-1) : holding[0]) ?? ''; };
    for (const language of module.languages) moduleRoots.set(language, { roots, ownRoot, built: module.built ?? null });
    frameworks.push({ name: `${module.languages[0]} tests`, config: null, tests: mine.map(file => file.path), roots: [...roots] });
  }
  if (!tests.size) return null;

  // Followed languages: what the tests import or call, and the files beside those, minus what the coverage settings leave out.
  const reached = new Set();
  const queue = [...tests].filter(path => FOLLOWED.has(byPath.get(path)?.language));
  for (const path of queue) reached.add(path);
  while (queue.length) {
    const file = byPath.get(queue.pop());
    if (!file) continue;
    for (const item of file.imports ?? []) {
      const target = resolveModule(file.path, item.module, file.language, pathSet);
      if (target && byPath.has(target) && !reached.has(target)) { reached.add(target); queue.push(target); }
    }
  }
  const walked = new Set();
  const stack = [...graph.nodes.values()].filter(item => tests.has(item.path)).map(item => item.id);
  while (stack.length) {
    const id = stack.pop();
    if (walked.has(id)) continue;
    walked.add(id);
    const item = graph.nodes.get(id);
    if (item) reached.add(item.path);
    for (const callee of graph.callees(id)) if (!walked.has(callee)) stack.push(callee);
  }
  const followedDirs = new Set([...reached].map(dirOf));
  const jsInclude = loaded.flatMap(framework => framework.include ?? []), jsExclude = loaded.flatMap(framework => framework.exclude ?? []);
  const jsIgnored = path => loaded.some(framework => framework.ignore?.(path));
  for (const file of scan.files) {
    // A test file is never source, whatever top-level code a table or a mock in it is; a source file may also hold tests (Rust).
    if (file.test || (holdsTests(file) && !file.methods.some(method => !method.test && method.node !== null))) continue;
    const { path, language } = file;
    if (JS.has(language)) {
      if (!jsTests.length) continue;
      const kept = jsInclude.length ? jsInclude.some(pattern => glob(pattern, path)) : followedDirs.has(dirOf(path));
      if (kept && !jsExclude.some(pattern => glob(pattern, path)) && !jsIgnored(path)) sources.add(path);
    } else if (language === 'python') {
      if (!python?.tests.length) continue;
      const kept = python.source ? python.source.some(dir => under(dir.replace(/\.$/, '').replace(/\/$/, ''), path) || under(dir.replaceAll('.', '/'), path) || under(`src/${dir.replaceAll('.', '/')}`, path)) : followedDirs.has(dirOf(path));
      if (kept && !python.omit.some(pattern => glob(pattern, path))) sources.add(path);
    } else if (moduleRoots.has(language)) {
      const { roots, ownRoot, built } = moduleRoots.get(language), root = ownRoot(path);
      if (!roots.has(root)) continue;
      const inside = root ? path.slice(root.length + 1) : path;
      // What the build compiles: Maven's and Gradle's src/main, Cargo's src, when the module is laid out that way. Without such a
      // convention, everything but the directories projects keep tools, benchmarks, examples and docs in.
      const layout = built && paths.some(other => under(root, other) && (root ? other.slice(root.length + 1) : other).startsWith(built));
      if (layout ? inside.startsWith(built) : !NOT_BUILT.test(inside)) sources.add(path);
    }
  }
  const left = scan.files.filter(file => !tests.has(file.path) && !sources.has(file.path)).map(file => file.path);
  return {
    frameworks: frameworks.map(({ name, version = null, config, error = null, tests: listed }) => ({ name, version, config, error, tests: listed?.length ?? null })),
    sources: sources.size, tests: tests.size, left_out: left.length, left_out_sample: left.slice(0, 20),
    test: path => tests.has(path), source: path => sources.has(path),
  };
}
