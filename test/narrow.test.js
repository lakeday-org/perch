import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { revision } from '../src/git.js';
import { scanRepository } from '../src/scan.js';
import { openStore } from '../src/store.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { analyzeTree } from '../src/analyze.js';
import { buildGraph } from '../src/graph.js';
import { methodNeighbours } from '../src/context.js';
import { heldBeside, heritageWords, overrides, testNeighbours } from '../src/narrow.js';
import { commitAll, initRepo, scriptedSystemOne } from './helpers.js';

const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function repository(files) {
  const root = await mkdtemp(join(tmpdir(), 'perch-narrow-'));
  cleanups.push(root);
  for (const [path, text] of Object.entries(files)) { await mkdir(join(root, dirname(path)), { recursive: true }); await writeFile(join(root, path), text); }
  await initRepo(root);
  return { root, revision: await revision(root), out: join(root, '.perch') };
}

const parsedPaths = scan => scan.files.map(file => file.path).sort();
/** What a request about each method in `paths` is built from, without the file text: its callers, callees and the edges among them. */
async function neighbourhoods(scan, paths) {
  const graph = buildGraph(scan.files, { crates: scan.crates, modules: scan.modules });
  const linesOf = async () => [];
  const ids = [...graph.nodes.values()].filter(node => paths.includes(node.path)).map(node => node.id).sort();
  return Object.fromEntries(await Promise.all(ids.map(async id => {
    const { calleeIds, callerIds, edges } = await methodNeighbours(graph, id, linesOf);
    return [id, { calleeIds, callerIds, edges, sites: callerIds.map(caller => [graph.site(caller, id), graph.isDynamic(caller, id)]) }];
  })));
}

const shop = {
  'src/cart.js': 'export function total(items) {\n  return items.reduce((sum, item) => sum + price(item), 0);\n}\n\nexport function price(item) {\n  return item.cents;\n}\n',
  'src/checkout.js': "import { total } from './cart.js';\n\nexport function checkout(cart) {\n  return { due: total(cart.items) };\n}\n",
  'tools/report.py': 'def report(rows):\n    return len(rows)\n\n\ndef main():\n    return report([])\n',
};

describe('a parse narrowed to the files a run covers', () => {
  it('parses a caller in an unchanged file and finds it, and leaves out a language nothing reaches', async () => {
    const repo = await repository(shop);
    const narrowed = await analyzeTree({ ...repo, analyzer, around: ['src/cart.js'] });
    expect(parsedPaths(narrowed)).toEqual(['src/cart.js', 'src/checkout.js']);
    expect(narrowed.coverage.unparsed).toBe(1);
    const whole = await analyzeTree({ ...repo, analyzer });
    expect(parsedPaths(whole)).toContain('tools/report.py');
    const around = await neighbourhoods(narrowed, ['src/cart.js']);
    expect(around['src/cart.js::total'].callerIds).toEqual(['src/checkout.js::checkout']);
    // The requests are built from these, so the narrowed parse has to give each method in scope exactly what the whole one does.
    expect(around).toEqual(await neighbourhoods(whole, ['src/cart.js']));
  });

  it('is kept apart from the parse of the whole tree, and each is reused only as itself', async () => {
    const repo = await repository(shop);
    let analyzed = 0;
    const counting = { analyzeSource: (...args) => { analyzed++; return analyzer.analyzeSource(...args); } };
    const narrowed = await analyzeTree({ ...repo, analyzer: counting, around: ['src/cart.js'] });
    expect(narrowed.around).toEqual(['src/cart.js']);
    expect(analyzed).toBe(2);
    const again = await analyzeTree({ ...repo, analyzer: counting, around: ['src/cart.js'] });
    expect([again.id, again.created_at, analyzed]).toEqual([narrowed.id, narrowed.created_at, 2]);
    // The whole tree is parsed, not answered by the narrowed parse of the same commit, and the other way round.
    const whole = await analyzeTree({ ...repo, analyzer: counting });
    expect(whole.id).not.toBe(narrowed.id);
    expect(whole.around).toBeUndefined();
    expect(parsedPaths(whole)).toContain('tools/report.py');
    expect(analyzed).toBe(5);
    expect(parsedPaths(await analyzeTree({ ...repo, analyzer: counting, around: ['src/cart.js'] }))).toEqual(['src/cart.js', 'src/checkout.js']);
    expect(analyzed).toBe(7);
  });

  it('parses a language whose files import the covered ones, and one the covered ones import', async () => {
    // `./rates` finds rates.py when no JavaScript or TypeScript file of that name exists, as graph.js resolves it.
    const repo = await repository({
      'src/rates.py': 'def rate(code):\n    return 1\n',
      'src/convert.js': "import { rate } from './rates';\n\nexport function convert(amount, code) {\n  return amount * rate(code);\n}\n",
      'lib/other.go': 'package lib\n\nfunc Other() int {\n\treturn 1\n}\n',
    });
    expect(parsedPaths(await analyzeTree({ ...repo, analyzer, around: ['src/rates.py'] }))).toEqual(['src/convert.js', 'src/rates.py']);
    expect(parsedPaths(await analyzeTree({ ...repo, analyzer, around: ['src/convert.js'] }))).toEqual(['src/convert.js', 'src/rates.py']);
  });

  it('parses a language that keeps test code in a directory with the covered code', async () => {
    // Whether tests/ is test code depends on every JavaScript and Python file in it. A Python module's importers can only be
    // found by parsing Python, so Python is parsed for the JavaScript beside it.
    const repo = await repository({
      'tests/conftest.py': 'import pytest\n\n\n@pytest.fixture\ndef cart():\n    return []\n',
      'tests/fixtures.js': 'export function makeCart() {\n  return [];\n}\n',
      'src/app.go': 'package app\n\nfunc Run() int {\n\treturn 1\n}\n',
    });
    expect(parsedPaths(await analyzeTree({ ...repo, analyzer, around: ['tests/fixtures.js'] }))).toEqual(['tests/conftest.py', 'tests/fixtures.js']);
  });

  it('reads JavaScript beside covered Python to judge their directory, without parsing the rest of it', async () => {
    const files = {
      'tests/test_cart.py': 'from helpers import total\n\n\ndef test_total():\n    assert total([]) == 0\n',
      'tests/helpers.py': 'def total(items):\n    return sum(items)\n',
      'tests/render.js': 'export function render(cart) {\n  return String(cart.length);\n}\n',
      'web/app.js': 'export function app() {\n  return 1;\n}\n',
      // Enough JavaScript besides that the files read beside the tests are a small part of it.
      ...Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(name => [`web/${name}.js`, `export function ${name}() {\n  return 1;\n}\n`])),
    };
    const flags = scan => Object.fromEntries(scan.files.map(file => [file.path, file.test]));
    const repo = await repository(files);
    const narrowed = await analyzeTree({ ...repo, analyzer, around: ['tests/helpers.py'] });
    expect(parsedPaths(narrowed)).toEqual(['tests/helpers.py', 'tests/test_cart.py']);
    const whole = await analyzeTree({ ...repo, analyzer });
    expect(flags(narrowed)).toEqual({ 'tests/helpers.py': true, 'tests/test_cart.py': true });
    expect(flags(whole)).toMatchObject(flags(narrowed));
    // Imported from web/, render.js is code something other than tests uses, so tests/ is not test code and nor is helpers.py.
    // The narrowed parse has to read web/ to know that.
    const imported = await repository({ ...files, 'web/app.js': "import { render } from '../tests/render.js';\n\nexport function app() {\n  return render([]);\n}\n" });
    const across = await analyzeTree({ ...imported, analyzer, around: ['tests/helpers.py'] });
    expect(parsedPaths(across)).toEqual(expect.arrayContaining(['tests/helpers.py', 'tests/render.js', 'tests/test_cart.py', 'web/app.js']));
    expect(flags(across)['tests/helpers.py']).toBe(false);
    expect(flags(across)).toEqual(flags(await analyzeTree({ ...imported, analyzer })));
  });
});

describe('a narrowed scan', () => {
  it('keeps what the last run said about methods in the languages it did not parse, until they change', async () => {
    const repo = await repository(shop);
    const scan = async (extra = {}) => scanRepository({ ...repo, analyzer, systemOne: scriptedSystemOne(), revision: await revision(repo.root), ...extra });
    await scan();
    const read = async () => (await openStore(repo.out).findings(0)).map(finding => finding.method).sort();
    expect(await read()).toContain('tools/report.py::report');
    const narrowed = await scan({ paths: ['src/cart.js'] });
    expect(narrowed.visited.every(visit => visit.path === 'src/cart.js')).toBe(true);
    // tools/report.py was not parsed, and it is unchanged, so what was said about it stands.
    expect(await read()).toEqual(['src/cart.js::price', 'src/cart.js::total', 'src/checkout.js::checkout', 'tools/report.py::main', 'tools/report.py::report']);
    // Once main is deleted its reading goes, as it would after a parse of everything; report's stays.
    await writeFile(join(repo.root, 'tools/report.py'), 'def report(rows):\n    return len(rows)\n');
    await commitAll(repo.root, 'drop main');
    await scan({ paths: ['src/cart.js'] });
    expect(await read()).toEqual(['src/cart.js::price', 'src/cart.js::total', 'src/checkout.js::checkout', 'tools/report.py::report']);
  });
});

describe('what can cross from one language to another', () => {
  it('counts a directory shared with unparsed test code only where a parsed file could be judged by it', () => {
    const sources = [{ path: 'scripts/build.ts', language: 'typescript' }, { path: 'scripts/__init__.py', language: 'python' }, { path: 'scripts/tool/run.py', language: 'python' }];
    const record = (path, methods = [], imports = []) => ({ path, language: 'python', methods, imports });
    const beside = heldBeside(sources, family => family === 'python');
    // An empty __init__.py is no node and no other file reads its verdict.
    expect(testNeighbours([record('scripts/__init__.py')], beside)).toEqual([]);
    expect(testNeighbours([record('scripts/tool/run.py', [{ id: 'scripts/tool/run.py::run' }])], beside).map(file => file.path)).toEqual(['scripts/build.ts']);
  });

  it('reads the names a JavaScript class could take a base from', () => {
    const text = 'import { Store } from "./store";\nexport class Cached<T extends { id: string }>\n  extends lib.Store<T>\n  implements Saving, Loading {\n  save() { return new Other(); }\n}\n';
    const bases = heritageWords(text);
    for (const name of ['lib', 'Store', 'Saving', 'Loading']) expect(bases.has(name)).toBe(true);
    expect(bases.has('Other')).toBe(false);
  });

  it('finds a class in another language that the graph would take for an override', () => {
    const owners = new Map([['Store', new Set(['save'])]]);
    expect(overrides({ bases: { CachedStore: ['lib.Store'] }, methods: [{ qualified_name: 'CachedStore.save' }] }, owners)).toBe(true);
    expect(overrides({ bases: { CachedStore: ['Store'] }, methods: [{ qualified_name: 'CachedStore.load' }] }, owners)).toBe(false);
    expect(overrides({ bases: { CachedStore: ['Base'] }, methods: [{ qualified_name: 'CachedStore.save' }] }, owners)).toBe(false);
  });
});
