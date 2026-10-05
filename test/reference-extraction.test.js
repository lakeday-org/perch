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

it('reads each Go import as its unquoted path, bound to its alias or else to the last element of the path', async () => {
  const source = 'package main\n\nimport f "fmt"\nimport "os"\nimport (\n\t"strings"\n\ts "sort"\n\t"github.com/acme/tool/log"\n)\n';
  const result = await analyzer.analyzeSource(source, 'go');
  expect(imports(result).filter(item => item.imported_name)).toEqual([
    { module: 'fmt', imported_name: 'fmt', alias: 'f' },
    { module: 'os', imported_name: 'os', alias: 'os' },
    { module: 'strings', imported_name: 'strings', alias: 'strings' },
    { module: 'sort', imported_name: 'sort', alias: 's' },
    { module: 'github.com/acme/tool/log', imported_name: 'github.com/acme/tool/log', alias: 'log' },
  ]);
  expect(new Set(imports(result).map(item => item.module))).toEqual(new Set(['fmt', 'os', 'strings', 'sort', 'github.com/acme/tool/log']));
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

it('hands over what a Go assignment assigns, never the names it assigns to', async () => {
  const source = 'package app\n\ntype User struct{}\n\nfunc (u *User) label() string { return "user" }\n\nfunc process() {}\n\nfunc run() bool {\n\tlabel := "x"\n\tlabel = "y"\n\tfor _, label = range []string{"a"} {\n\t}\n\tcallback := process\n\tcallback()\n\treturn label == ""\n}\n';
  const result = await analyzer.analyzeSource(source, 'go');
  expect(result.references.filter(ref => ref.kind === 'value').map(ref => ref.reference)).toEqual(['process']);
  const scan = await analyzeFiles([{ path: 'app.go', sha: 'fixture' }], { analyzer, readSource: async () => source });
  const graph = buildGraph(scan.files);
  expect(graph.callees('app.go::run')).toEqual(['app.go::process']);
  expect(graph.isDynamic('app.go::run', 'app.go::process')).toBe(true);
});

const reads = result => result.references.filter(ref => ref.kind === 'read').map(ref => ref.reference);

it('records a member read nothing calls as the whole chain, and not the callee of a call', async () => {
  const js = 'function key() {\n  const url = config.api.url;\n  client.send(process.env.PAYMENTS_KEY);\n  return import.meta.env.MODE;\n}\n';
  expect(reads(await analyzer.analyzeSource(js, 'javascript'))).toEqual(['config.api.url', 'process.env.PAYMENTS_KEY', 'import.meta.env.MODE']);
  const py = 'import os\n\ndef key():\n    token = os.environ["PAYMENTS_KEY"]\n    return os.path.join(token, "x")\n';
  expect(reads(await analyzer.analyzeSource(py, 'python'))).toEqual(['os.environ']);
  const scan = await analyzeFiles([{ path: 'k.py', sha: 'k' }], { analyzer, readSource: async () => py });
  expect(buildGraph(scan.files).reads('k.py::key')).toEqual([{ name: 'os.environ', line: 4 }]);
});
