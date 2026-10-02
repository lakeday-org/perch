import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createAnalyzer } from '../src/treesitter/index.ts';
import { analyzeFiles } from '../src/analysis.js';
import { buildGraph } from '../src/graph.js';

const analyzer = createAnalyzer();
const calls = result => result.references.filter(ref => ref.kind === 'call').map(ref => ref.reference);
const imports = result => result.references.filter(ref => ref.kind === 'import').map(({ module, imported_name, alias }) => ({ module, imported_name, alias }));

it('records a call to a function named outside ASCII and links it in the graph', async () => {
  const source = 'function café(value) { return value; }\nfunction outer(value) { return café(value); }\n';
  const result = await analyzer.analyzeSource(source, 'javascript');
  expect(calls(result)).toEqual(['café']);
  const scan = await analyzeFiles([{ path: 'app.js', sha: 'fixture' }], { analyzer, readSource: async () => source });
  expect(buildGraph(scan.files).callees('app.js::outer')).toEqual(['app.js::café']);
});

it('names Ruby and Swift calls by their receiver and method, and links them in the graph', async () => {
  const ruby = 'class Greeter\n  def helper(value)\n    value\n  end\n\n  def run\n    helper(1)\n    self.helper(2)\n    other&.helper(3)\n    Foo::Bar.baz\n  end\nend\n';
  const swift = 'struct Greeter {\n  func helper(_ value: Int) -> Int { value }\n  func run() {\n    helper(1)\n    self.helper(2)\n    other?.helper(3)\n    Foo.Bar.baz()\n  }\n}\n';
  expect(calls(await analyzer.analyzeSource(ruby, 'ruby'))).toEqual(['helper', 'self.helper', 'other.helper', 'Foo::Bar.baz']);
  expect(calls(await analyzer.analyzeSource(swift, 'swift'))).toEqual(['helper', 'self.helper', 'other.helper', 'Foo.Bar.baz']);
  const scan = await analyzeFiles([{ path: 'app.rb', sha: 'a' }, { path: 'App.swift', sha: 'b' }], { analyzer, readSource: async file => (file.path === 'app.rb' ? ruby : swift) });
  const graph = buildGraph(scan.files);
  expect(graph.callees('app.rb::run')).toEqual(['app.rb::helper']);
  expect(graph.callees('App.swift::Greeter.run')).toEqual(['App.swift::Greeter.helper']);
});

it('reads a TypeScript import-equals declaration as the module and its local binding, and resolves calls through it', async () => {
  const a = 'import Foo = require("./foo");\nexport function f() { return Foo.bar(); }\n';
  const foo = 'export function bar() { return 1; }\n';
  const result = await analyzer.analyzeSource(a, 'typescript');
  expect(imports(result)).toContainEqual({ module: './foo', imported_name: '*', alias: 'Foo' });
  expect(imports(result).every(item => item.module === './foo')).toBe(true);
  const scan = await analyzeFiles([{ path: 'a.ts', sha: 'a' }, { path: 'foo.ts', sha: 'b' }], { analyzer, readSource: async file => (file.path === 'a.ts' ? a : foo) });
  expect(buildGraph(scan.files).callees('a.ts::f')).toEqual(['foo.ts::bar']);
});

it('records import(...) as an import of its module, in a type position or as a dynamic import, never as a call', async () => {
  const typed = await analyzer.analyzeSource('type T = import("./foo").Foo;\nexport function f(x: T) { return x; }\n', 'typescript');
  expect(calls(typed)).toEqual([]);
  expect(imports(typed)).toContainEqual({ module: './foo', imported_name: null, alias: null });
  const dynamic = await analyzer.analyzeSource('export async function load() { const m = await import("./foo"); return m; }\n', 'javascript');
  expect(calls(dynamic)).toEqual([]);
  expect(imports(dynamic)).toContainEqual({ module: './foo', imported_name: null, alias: null });
});

it('links Python calls through `import module` and `from module import name`', async () => {
  const root = fileURLToPath(new URL('./fixtures/order-service/', import.meta.url));
  const paths = (await readdir(root)).filter(path => path.endsWith('.py'));
  const scan = await analyzeFiles(paths.map(path => ({ path, sha: path })), { analyzer, readSource: file => readFile(join(root, file.path), 'utf8') });
  const graph = buildGraph(scan.files);
  expect(graph.callees('main.py::<top-level>')).toContain('checkout.py::can_fulfil');
  expect(graph.callees('checkout.py::place_order')).toEqual(expect.arrayContaining(['cart.py::subtotal', 'cart.py::apply_discount', 'inventory.py::reserve']));
});

it('reads each name in a Python import statement as its own binding', async () => {
  const result = await analyzer.analyzeSource('import a.b, c as d\nfrom .e import f, g as h\nfrom . import i\n', 'python');
  expect(imports(result).filter(item => item.imported_name)).toEqual([
    { module: 'a.b', imported_name: '*', alias: 'a' },
    { module: 'c', imported_name: '*', alias: 'd' },
    { module: '.e', imported_name: 'f', alias: 'f' },
    { module: '.e', imported_name: 'g', alias: 'h' },
    { module: '.', imported_name: 'i', alias: 'i' },
  ]);
});

it('looks a Python name imported from a package up as the submodule it names', async () => {
  const sources = {
    'pkg/__init__.py': 'def helper():\n    return 0\n',
    'pkg/utils.py': 'def helper():\n    return 1\n',
    'pkg/relative.py': 'from . import utils\n\ndef run():\n    return utils.helper()\n',
    'absolute.py': 'from pkg import utils\n\ndef run():\n    return utils.helper()\n',
  };
  const scan = await analyzeFiles(Object.keys(sources).map(path => ({ path, sha: path })), { analyzer, readSource: async file => sources[file.path] });
  const graph = buildGraph(scan.files);
  expect(graph.callees('pkg/relative.py::run')).toEqual(['pkg/utils.py::helper']);
  expect(graph.callees('absolute.py::run')).toEqual(['pkg/utils.py::helper']);
});

it('looks a Rust module brought in by `use` up as that module', async () => {
  const sources = {
    'src/lib.rs': 'mod app;\nmod net;\n',
    'src/net.rs': 'pub fn connect() {}\n',
    'src/app.rs': 'use crate::net;\n\npub fn start() { net::connect(); }\n',
  };
  const scan = await analyzeFiles(Object.keys(sources).map(path => ({ path, sha: path })), { analyzer, readSource: async file => sources[file.path] });
  expect(buildGraph(scan.files).callees('src/app.rs::start')).toEqual(['src/net.rs::connect']);
});
