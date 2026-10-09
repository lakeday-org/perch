import { describe, expect, it } from 'vitest';
import { buildGraph, resolveModule } from '../src/graph.js';

const method = (path, name, line, risk = 10) => ({ id: `${path}::${name}`, node: `function:${line}`, name: name.split('.').at(-1), qualified_name: name, line, end_line: line + 2, hash: 'h', metrics: { risk_score: risk } });

describe('method graph', () => {
  it('preserves Go package order, top-level preference, language boundaries and unresolved calls', () => {
    const file = (path, language, names, calls = [], values = []) => ({ path, language, methods: names.map((name, i) => method(path, name, i + 1)), calls, values, imports: [] });
    const files = [
      file('other/a.go', 'go', ['helper']),
      file('pkg/a.js', 'javascript', ['helper']),
      file('pkg/a.go', 'go', ['Runner.Run'], [
        { from: 'pkg/a.go::Runner.Run', name: 'helper', line: 2 },
        { from: 'pkg/a.go::Runner.Run', name: 'unknown', line: 3 },
      ], [{ from: 'pkg/a.go::Runner.Run', name: 'callback', line: 4 }]),
      file('pkg/b.go', 'go', ['Receiver.helper', 'helper', 'callback']),
      file('pkg/c.go', 'go', ['helper', 'callback']),
      file('pkg/d.go', 'go', ['helper', 'Run'], [{ from: 'pkg/d.go::Run', name: 'helper', line: 2 }]),
    ];
    const graph = buildGraph(files);
    expect(graph.callees('pkg/a.go::Runner.Run')).toEqual(['pkg/b.go::helper', 'pkg/b.go::callback']);
    expect(graph.callees('pkg/d.go::Run')).toEqual(['pkg/d.go::helper']);
    expect(graph.callers('pkg/b.go::helper')).toEqual(['pkg/a.go::Runner.Run']);
    expect(graph.isDynamic('pkg/a.go::Runner.Run', 'pkg/b.go::callback')).toBe(true);
    expect(graph.site('pkg/a.go::Runner.Run', 'pkg/b.go::callback')).toBe(4);
  });

  it("resolves a default import, and CommonJS's exports, to the function defined", () => {
    const file = (path, names, extra = {}) => ({ path, language: 'javascript', methods: names.map((name, i) => method(path, name, i + 1)), calls: [], values: [], imports: [], ...extra });
    const files = [
      file('lib/combineURLs.js', ['combineURLs'], { default_export: 'combineURLs' }),
      file('lib/utils.js', ['exports.etag', 'compile'], { default_export: null }),
      file('lib/view.js', ['View'], { default_export: 'View' }),
      file('test/a.test.js', ['joins'], {
        imports: [{ module: '../lib/combineURLs.js', name: 'default', alias: 'join' }, { module: '../lib/utils.js', name: '*', alias: 'utils' },
          { module: '../lib/utils.js', name: 'etag', alias: 'etag' }, { module: '../lib/view.js', name: '*', alias: 'View' }],
        calls: [{ from: 'test/a.test.js::joins', name: 'join', line: 2 }, { from: 'test/a.test.js::joins', name: 'utils.etag', line: 3 },
          { from: 'test/a.test.js::joins', name: 'etag', line: 4 }, { from: 'test/a.test.js::joins', name: 'View', line: 5 }],
      }),
    ];
    expect(buildGraph(files).callees('test/a.test.js::joins').sort()).toEqual(['lib/combineURLs.js::combineURLs', 'lib/utils.js::exports.etag', 'lib/view.js::View']);
  });

  it('follows a barrel file to the module that defines a name', () => {
    const file = (path, names, extra = {}) => ({ path, language: 'typescript', methods: names.map((name, i) => method(path, name, i + 1)), calls: [], values: [], imports: [], ...extra });
    const files = [
      file('src/index.ts', [], { imports: [{ module: './encoding', name: '*', alias: '*', reexport: true }, { module: './url', name: 'parseURL', alias: 'parse', reexport: true }] }),
      file('src/encoding.ts', ['encodePath']),
      file('src/url.ts', ['parseURL']),
      file('test/a.test.ts', ['works'], {
        imports: [{ module: '../src', name: 'encodePath', alias: 'encodePath' }, { module: '../src', name: 'parse', alias: 'parse' }],
        calls: [{ from: 'test/a.test.ts::works', name: 'encodePath', line: 2 }, { from: 'test/a.test.ts::works', name: 'parse', line: 3 }],
      }),
    ];
    expect(buildGraph(files).callees('test/a.test.ts::works').sort()).toEqual(['src/encoding.ts::encodePath', 'src/url.ts::parseURL']);
  });

  it("follows a Python package in src/ through its __init__.py to the module that defines a name", () => {
    const file = (path, names, extra = {}) => ({ path, language: 'python', methods: names.map((name, i) => method(path, name, i + 1)), calls: [], values: [], imports: [], ...extra });
    const files = [
      file('src/click/__init__.py', [], { imports: [{ module: '.utils', name: 'echo', alias: 'echo' }] }),
      file('src/click/utils.py', ['echo']),
      file('tests/test_basic.py', ['test_echo'], {
        imports: [{ module: 'click', name: '*', alias: 'click' }],
        calls: [{ from: 'tests/test_basic.py::test_echo', name: 'click.echo', line: 2 }],
      }),
    ];
    expect(buildGraph(files).callees('tests/test_basic.py::test_echo')).toEqual(['src/click/utils.py::echo']);
  });

  it('links a Kotlin call on any receiver to the extension function of that name', () => {
    const file = (path, methods, extra = {}) => ({ path, language: 'kotlin', package: 'okio', methods, calls: [], values: [], imports: [], ...extra });
    const files = [
      file('okio/Utf8.kt', [{ ...method('okio/Utf8.kt', 'String.utf8Size', 1), extension: true }, { ...method('okio/Utf8.kt', 'ByteArray.utf8Size', 4), extension: true, id: 'okio/Utf8.kt::ByteArray.utf8Size' }]),
      file('okio/Hex.kt', [{ ...method('okio/Hex.kt', 'String.decodeHex', 1), extension: true }]),
      file('okio/Buffer.kt', [method('okio/Buffer.kt', 'Buffer.size', 1)]),
      file('okio/Utf8Test.kt', [method('okio/Utf8Test.kt', 'Utf8Test.sizes', 1)], {
        calls: [{ from: 'okio/Utf8Test.kt::Utf8Test.sizes', name: 's.decodeHex', line: 2 }, { from: 'okio/Utf8Test.kt::Utf8Test.sizes', name: '$receiver.decodeHex', line: 3 },
          // utf8Size is declared for two receivers, and which one this is depends on a type the tree does not give.
          { from: 'okio/Utf8Test.kt::Utf8Test.sizes', name: 's.utf8Size', line: 4 }],
      }),
    ];
    const graph = buildGraph(files);
    expect(graph.callees('okio/Utf8Test.kt::Utf8Test.sizes')).toEqual(['okio/Hex.kt::String.decodeHex']);
    // An extension is no class member: String.decodeHex does not make a class String.
    expect(graph.callees('okio/Utf8Test.kt::Utf8Test.sizes')).not.toContain('okio/Buffer.kt::Buffer.size');
  });

  it('links a call to a class to the constructor it runs', () => {
    const file = (path, language, names, extra = {}) => ({ path, language, methods: names.map((name, i) => method(path, name, i + 1)), calls: [], values: [], imports: [], ...extra });
    const files = [
      file('src/click/utils.py', 'python', ['_LazyFile.__init__', '_LazyFile.open']),
      file('tests/test_lazy.py', 'python', ['test_lazy'], { imports: [{ module: 'src.click.utils', name: '_LazyFile', alias: '_LazyFile' }],
        calls: [{ from: 'tests/test_lazy.py::test_lazy', name: '_LazyFile', line: 2 }] }),
      file('src/cart.ts', 'typescript', ['Cart.constructor', 'Cart.total']),
      file('test/cart.test.ts', 'typescript', ['makes'], { imports: [{ module: '../src/cart', name: 'Cart', alias: 'Cart' }],
        calls: [{ from: 'test/cart.test.ts::makes', name: 'Cart', line: 2 }] }),
    ];
    const graph = buildGraph(files);
    expect(graph.callees('tests/test_lazy.py::test_lazy')).toEqual(['src/click/utils.py::_LazyFile.__init__']);
    expect(graph.callees('test/cart.test.ts::makes')).toEqual(['src/cart.ts::Cart.constructor']);
  });

  it("follows a Rust crate's name and its pub use to the function a test calls", () => {
    const file = (path, names, extra = {}) => ({ path, language: 'rust', methods: names.map((name, i) => method(path, name, i + 1)), calls: [], values: [], imports: [], ...extra });
    const files = [
      file('src/lib.rs', [], { imports: [{ module: 'crate::de', name: 'from_str', alias: 'from_str' }, { module: 'crate::ser', name: 'to_string', alias: 'to_string' }] }),
      file('src/de.rs', ['from_str']),
      file('src/ser.rs', ['to_string']),
      file('tests/test.rs', ['parses'], {
        imports: [{ module: 'serde_json', name: 'from_str', alias: 'from_str' }],
        calls: [{ from: 'tests/test.rs::parses', name: 'from_str', line: 2 }, { from: 'tests/test.rs::parses', name: 'serde_json::to_string', line: 3 }],
      }),
    ];
    const graph = buildGraph(files, { crates: [{ name: 'serde_json', root: '', lib: 'src/lib.rs' }] });
    expect(graph.callees('tests/test.rs::parses').sort()).toEqual(['src/de.rs::from_str', 'src/ser.rs::to_string']);
  });

  it('links a call to a helper declared inside an unnamed callback, when it is the only one of that name in the file', () => {
    const file = (path, names, extra = {}) => ({ path, language: 'javascript', methods: names.map((name, i) => method(path, name, i + 1)), calls: [], values: [], imports: [], ...extra });
    const files = [file('test/a.test.js', ['<anonymous>.measuredRun', 'suite > reads', '<anonymous>.twice', '<anonymous>.other.twice'], {
      calls: [{ from: 'test/a.test.js::suite > reads', name: 'measuredRun', line: 2 }, { from: 'test/a.test.js::suite > reads', name: 'twice', line: 3 }] })];
    expect(buildGraph(files).callees('test/a.test.js::suite > reads')).toEqual(['test/a.test.js::<anonymous>.measuredRun']);
  });

  it('resolves module specifiers per language', () => {
    const paths = new Set(['src/a.js', 'src/b.ts', 'src/dir/index.js', 'pkg/__init__.py', 'pkg/util.py', 'pkg/sub/mod.py', 'crate/src/lib.rs', 'crate/src/util.rs', 'crate/src/net/mod.rs']);
    expect(resolveModule('src/a.js', './b.js', 'javascript', paths)).toBe('src/b.ts');
    expect(resolveModule('src/a.js', './dir', 'javascript', paths)).toBe('src/dir/index.js');
    expect(resolveModule('src/a.js', 'lodash', 'javascript', paths)).toBeNull();
    expect(resolveModule('pkg/sub/mod.py', '.util', 'python', paths)).toBeNull();
    expect(resolveModule('pkg/sub/mod.py', '..util', 'python', paths)).toBe('pkg/util.py');
    expect(resolveModule('pkg/sub/mod.py', 'pkg.util', 'python', paths)).toBe('pkg/util.py');
    expect(resolveModule('pkg/sub/mod.py', 'pkg', 'python', paths)).toBe('pkg/__init__.py');
    expect(resolveModule('crate/src/lib.rs', 'crate::util', 'rust', paths)).toBe('crate/src/util.rs');
    expect(resolveModule('crate/src/util.rs', 'crate::net', 'rust', paths)).toBe('crate/src/net/mod.rs');
    expect(resolveModule('crate/src/net/mod.rs', 'super::util', 'rust', paths)).toBe('crate/src/util.rs');
  });

  it('resolves Rust paths by the module a file is, not the directory it sits in', () => {
    const paths = new Set(['src/lib.rs', 'src/util.rs', 'src/net/mod.rs', 'src/net/client.rs', 'src/net/util.rs', 'src/net/client/retry.rs', 'src/net/client/retry/backoff.rs']);
    expect(resolveModule('src/net/client.rs', 'super', 'rust', paths)).toBe('src/net/mod.rs');
    expect(resolveModule('src/net/mod.rs', 'super', 'rust', paths)).toBe('src/lib.rs');
    expect(resolveModule('src/net/client.rs', 'super::util', 'rust', paths)).toBe('src/net/util.rs');
    expect(resolveModule('src/net/client.rs', 'super::super', 'rust', paths)).toBe('src/lib.rs');
    expect(resolveModule('src/net/client/retry.rs', 'super', 'rust', paths)).toBe('src/net/client.rs');
    expect(resolveModule('src/net/client/retry/backoff.rs', 'super::super', 'rust', paths)).toBe('src/net/client.rs');
    expect(resolveModule('src/net/client.rs', 'self::retry', 'rust', paths)).toBe('src/net/client/retry.rs');
    expect(resolveModule('src/net/client.rs', 'retry::backoff', 'rust', paths)).toBe('src/net/client/retry/backoff.rs');
    expect(resolveModule('src/net/client.rs', 'self', 'rust', paths)).toBe('src/net/client.rs');
    expect(resolveModule('src/net/client.rs', 'super::Kind', 'rust', paths)).toBe('src/net/mod.rs');
    expect(resolveModule('src/net/client.rs', 'crate', 'rust', paths)).toBe('src/lib.rs');
    expect(resolveModule('src/lib.rs', 'super', 'rust', paths)).toBeNull();
    expect(resolveModule('src/net/client.rs', 'std::collections', 'rust', paths)).toBeNull();

    const file = (path, names, calls, imports) => ({ path, language: 'rust', methods: names.map((name, i) => method(path, name, i + 1)), calls, values: [], imports });
    const graph = buildGraph([
      file('src/net/mod.rs', ['helper'], [], []),
      file('src/net/client.rs', ['connect'], [{ from: 'src/net/client.rs::connect', name: 'helper', line: 2 }], [{ module: 'super', name: 'helper', alias: 'helper' }]),
    ]);
    expect(graph.callees('src/net/client.rs::connect')).toEqual(['src/net/mod.rs::helper']);
  });

  it('links calls through same-file names, imports, classes, and Go packages', () => {
    const files = [
      { path: 'src/a.js', language: 'javascript', test: false, methods: [method('src/a.js', 'f', 1, 50), method('src/a.js', 'g', 10, 20), method('src/a.js', 'K.m', 20, 30)],
        calls: [{ name: 'g', from: 'src/a.js::f', line: 2 }, { name: 'h', from: 'src/a.js::f', line: 3 }, { name: 'this.m', from: 'src/a.js::g', line: 11 }, { name: 'util.k', from: 'src/a.js::g', line: 12 }, { name: 'console.log', from: 'src/a.js::f', line: 4 }],
        imports: [{ module: './b.js', name: 'h', alias: 'h' }, { module: './b.js', name: 'util', alias: 'util' }] },
      { path: 'src/b.js', language: 'javascript', test: false, methods: [method('src/b.js', 'h', 1), method('src/b.js', 'util.k', 5)], calls: [{ name: 'k', from: 'src/b.js::h', line: 2 }], imports: [] },
      { path: 'go/x.go', language: 'go', test: false, methods: [method('go/x.go', 'Run', 1)], calls: [{ name: 'helper', from: 'go/x.go::Run', line: 2 }], imports: [] },
      { path: 'go/y.go', language: 'go', test: false, methods: [method('go/y.go', 'helper', 1)], calls: [], imports: [] },
      { path: 'test/a.test.js', language: 'javascript', test: true, methods: [method('test/a.test.js', 't', 1)], calls: [{ name: 'f', from: 'test/a.test.js::t', line: 2 }], imports: [{ module: '../src/a.js', name: 'f', alias: 'f' }] },
    ];
    const graph = buildGraph(files);
    expect(graph.callees('src/a.js::f').sort()).toEqual(['src/a.js::g', 'src/b.js::h']);
    // g is a free function, so its `this` is no class of this file, and K.m is not what it calls.
    expect(graph.callees('src/a.js::g').sort()).toEqual(['src/b.js::util.k']);
    // A bare k in JavaScript is a name in scope, and util.k is a member of an object, not one.
    expect(graph.callees('src/b.js::h')).toEqual([]);
    expect(graph.callees('go/x.go::Run')).toEqual(['go/y.go::helper']);
    expect(graph.callers('src/a.js::f')).toEqual(['test/a.test.js::t']);
    expect(graph.callers('src/b.js::h')).toEqual(['src/a.js::f']);
    expect(graph.site('src/a.js::f', 'src/b.js::h')).toBe(3);
    expect(graph.nodes.get('test/a.test.js::t').test).toBe(true);
    expect(graph.edgeCount()).toBe(5);
  });

  it('resolves a bare name and a receiver by the scoping of the calling language, and links nothing it cannot', () => {
    const file = (path, language, methods, calls, extra = {}) => ({ path, language, test: false, imports: [], ...extra,
      methods: methods.map(([name, line]) => method(path, name, line)), calls: calls.map(([name, from, line]) => ({ name, from: `${path}::${from}`, line })) });
    const graph = buildGraph([
      file('shop/cart.py', 'python', [['total', 1], ['Cart.add', 10], ['Cart.total', 20], ['Cart.add.check', 12]], [
        ['total', 'Cart.add', 11], ['self.total', 'Cart.add', 13], ['check', 'Cart.add', 14], ['cart.total', 'Cart.add', 15]]),
      file('shop/Cart.java', 'java', [['Cart.add', 1], ['Cart.total', 10]], [['total', 'Cart.add', 2], ['this.total', 'Cart.add', 3]], { package: 'shop' }),
      file('shop/cart.ts', 'typescript', [['Cart.add', 1], ['Cart.total', 10], ['total', 20]], [['total', 'Cart.add', 2], ['this.total', 'Cart.add', 3], ['item.total', 'Cart.add', 4]]),
    ]);
    // Python: a bare total is the module's function, self.total is the class's method, check is nested in add, and cart.total
    // on an object of no known type is nothing.
    expect(graph.callees('shop/cart.py::Cart.add').sort()).toEqual(['shop/cart.py::Cart.add.check', 'shop/cart.py::Cart.total', 'shop/cart.py::total']);
    expect(graph.external('shop/cart.py::Cart.add').map(call => call.name)).toEqual(['cart.total']);
    // Java has an implicit this, so a bare total inside Cart is Cart.total, and so is this.total.
    expect(graph.callees('shop/Cart.java::Cart.add')).toEqual(['shop/Cart.java::Cart.total']);
    // TypeScript has none: bare total is the top-level function, this.total the method, item.total nothing.
    expect(graph.callees('shop/cart.ts::Cart.add').sort()).toEqual(['shop/cart.ts::Cart.total', 'shop/cart.ts::total']);
    expect(graph.external('shop/cart.ts::Cart.add').map(call => call.name)).toEqual(['item.total']);
  });
  it('links a function handed on as a value the way a call would, and a variable of the same name to nothing', () => {
    const file = (path, language, methods, values, imports = []) => ({ path, language, test: false, imports, calls: [],
      methods: methods.map(([name, line]) => method(path, name, line)), values: values.map(([name, from, line]) => ({ name, from: `${path}::${from}`, line })) });
    const graph = buildGraph([
      file('src/meter.js', 'javascript', [['createMeter', 1], ['createMeter.total', 5]], []),
      file('src/routes.js', 'javascript', [['register', 1]], [['onCharge', 'register', 2]], [{ module: './handlers.js', name: 'onCharge', alias: 'onCharge' }]),
      file('src/handlers.js', 'javascript', [['onCharge', 1]], []),
      // A Python test passing its local `total` to assertEqual: a variable, not the one method named total in the repository.
      file('tests/test_order.py', 'python', [['test_total', 1]], [['total', 'test_total', 3]]),
    ]);
    expect(graph.callees('src/routes.js::register')).toEqual(['src/handlers.js::onCharge']);
    expect(graph.isDynamic('src/routes.js::register', 'src/handlers.js::onCharge')).toBe(true);
    expect(graph.callees('tests/test_order.py::test_total')).toEqual([]);
  });
});

describe('a method called on a parameter', () => {
  /** Analyze an in-memory repository the way a scan does, and build its graph. */
  async function repository(files) {
    const { analyzeFiles } = await import('../src/analysis.js');
    const { createAnalyzer } = await import('../src/treesitter/index.ts');
    const scan = await analyzeFiles(Object.keys(files).map(path => ({ type: 'blob', path, sha: path })), { analyzer: createAnalyzer(), readSource: file => files[file.path] });
    return buildGraph(scan.files);
  }

  it('is the method of what each caller passes, through a destructured option', async () => {
    const graph = await repository({
      'src/parse.js': 'export class Parser {\n  parse(files) {\n    return files.length;\n  }\n}\n\nexport function createParser() {\n  return new Parser();\n}\n',
      'src/run.js': 'export function run(files, { parser, debug = () => {} }) {\n  debug(files);\n  return parser.parse(files);\n}\n',
      'test/run.test.js': "import { createParser } from '../src/parse.js';\nimport { run } from '../src/run.js';\n\nconst parser = createParser();\n\ntest('runs', () => {\n  expect(run([], { parser })).toBe(0);\n});\n",
    });
    // run's `parser` is what its caller passed: the parser createParser returns, a Parser, whose parse it calls.
    expect(graph.callees('src/run.js::run')).toEqual(['src/parse.js::Parser.parse']);
    expect(graph.callers('src/parse.js::Parser.parse')).toEqual(['src/run.js::run']);
    expect(graph.nodes.get('src/run.js::run').params).toEqual([{ name: 'files', index: 0 }, { name: 'parser', index: 1, field: 'parser' }, { name: 'debug', index: 1, field: 'debug' }]);
  });

  it('follows a positional parameter and a keyword one', async () => {
    const graph = await repository({
      'shop/parse.py': 'class Parser:\n    def parse(self, files):\n        return len(files)\n\n\nclass Reader:\n    def parse(self, files):\n        return 0\n',
      'shop/run.py': 'def run(files, parser, reader=None):\n    reader.parse(files)\n    return parser.parse(files)\n',
      'tests/test_run.py': 'from shop.parse import Parser, Reader\nfrom shop.run import run\n\n\ndef test_run():\n    assert run([], Parser(), reader=Reader()) == 0\n',
    });
    expect(graph.callees('shop/run.py::run').sort()).toEqual(['shop/parse.py::Parser.parse', 'shop/parse.py::Reader.parse']);
  });

  it('reaches every class the callers pass, and nothing for a parameter nobody passes a value for', async () => {
    const graph = await repository({
      'src/kinds.js': 'export class A {\n  go() {\n    return 1;\n  }\n}\nexport class B {\n  go() {\n    return 2;\n  }\n}\n',
      'src/run.js': 'export function run(thing) {\n  return thing.go();\n}\nexport function idle(thing) {\n  return thing.go();\n}\n',
      'test/run.test.js': "import { A, B } from '../src/kinds.js';\nimport { run } from '../src/run.js';\n\ntest('a', () => { run(new A()); });\ntest('b', () => { run(new B()); });\n",
    });
    expect(graph.callees('src/run.js::run').sort()).toEqual(['src/kinds.js::A.go', 'src/kinds.js::B.go']);
    expect(graph.callees('src/run.js::idle')).toEqual([]);
  });
});

describe('functions handed over and objects handed back', () => {
  async function repository(files) {
    const { analyzeFiles } = await import('../src/analysis.js');
    const { createAnalyzer } = await import('../src/treesitter/index.ts');
    const scan = await analyzeFiles(Object.keys(files).map(path => ({ type: 'blob', path, sha: path })), { analyzer: createAnalyzer(), readSource: file => files[file.path] });
    return buildGraph(scan.files);
  }

  it('calls the function a caller passed for a parameter', async () => {
    const graph = await repository({
      'src/read.js': 'export async function readAll(files, { readSource }) {\n  return Promise.all(files.map(file => readSource(file)));\n}\n',
      'src/tree.js': "import { readAll } from './read.js';\n\nexport function load(root, files) {\n  return readAll(files, { readSource: file => fromDisk(root, file) });\n}\n\nfunction fromDisk(root, file) {\n  return root + file;\n}\n",
    });
    // readAll's readSource is the function load wrote in place, so readAll reaches it, and through it fromDisk.
    expect(graph.callees('src/read.js::readAll')).toEqual(['src/tree.js::load.readSource']);
    expect(graph.callees('src/tree.js::load.readSource')).toEqual(['src/tree.js::fromDisk']);
  });

  it('finds a member of the object a factory returns', async () => {
    const graph = await repository({
      'src/counter.js': 'export function liveCounter(io) {\n  const draw = () => io.write(count);\n  let count = 0;\n  return { draw, update(n) { count = n; draw(); }, stop: () => io.clear() };\n}\n',
      'src/scan.js': "import { liveCounter } from './counter.js';\n\nexport function scan(io) {\n  const files = liveCounter(io);\n  files.update(3);\n  files.stop();\n}\n",
    });
    expect(graph.callees('src/scan.js::scan').sort()).toEqual(['src/counter.js::liveCounter', 'src/counter.js::liveCounter.stop', 'src/counter.js::liveCounter.update']);
    expect(graph.callees('src/counter.js::liveCounter.update')).toEqual(['src/counter.js::liveCounter.draw']);
  });

  it('reads a getter as the call it is', async () => {
    const graph = await repository({
      'src/node.js': 'export class Node {\n  constructor(native) { this.native = native; }\n  get type() { return this.native.kind(); }\n}\n',
      'src/walk.js': "import { Node } from './node.js';\n\nexport function kindOf(native) {\n  const node = new Node(native);\n  return node.type;\n}\n",
    });
    expect(graph.callees('src/walk.js::kindOf').sort()).toEqual(['src/node.js::Node.constructor', 'src/node.js::Node.type']);
  });
});

describe('a table of functions called through a key', () => {
  it('reaches every function in the table, and one by name when the key is written', async () => {
    const { analyzeFiles } = await import('../src/analysis.js');
    const { createAnalyzer } = await import('../src/treesitter/index.ts');
    const files = {
      'src/cli.js': "const commands = {\n  scan(io) { return 3; },\n  coverage(io) { return 4; },\n  help: () => 0,\n};\n\nexport function main(name, io) {\n  return commands[name](io);\n}\n\nexport function usage(io) {\n  return commands['help'](io);\n}\n",
    };
    const scan = await analyzeFiles(Object.keys(files).map(path => ({ type: 'blob', path, sha: path })), { analyzer: createAnalyzer(), readSource: file => files[file.path] });
    const graph = buildGraph(scan.files);
    expect(graph.callees('src/cli.js::main').sort()).toEqual(['src/cli.js::commands.coverage', 'src/cli.js::commands.help', 'src/cli.js::commands.scan']);
    expect(graph.isDynamic('src/cli.js::main', 'src/cli.js::commands.scan')).toBe(true);
    expect(graph.callees('src/cli.js::usage')).toEqual(['src/cli.js::commands.help']);
  });
});

describe('a function written inside another', () => {
  it('is reached by its parent, whoever calls it', async () => {
    const { analyzeFiles } = await import('../src/analysis.js');
    const { createAnalyzer } = await import('../src/treesitter/index.ts');
    const files = {
      'src/visit.js': 'export function walk(root, visitors) {\n  for (const visitor of visitors.filter(v => v.enter)) visitor.enter(root);\n}\n',
      'src/read.js': "import { walk } from './visit.js';\n\nexport function readAll(root) {\n  const seen = [];\n  walk(root, [{ enter: node => seen.push(mark(node)) }]);\n  return seen;\n}\n\nfunction mark(node) {\n  return node.id;\n}\n",
    };
    const scan = await analyzeFiles(Object.keys(files).map(path => ({ type: 'blob', path, sha: path })), { analyzer: createAnalyzer(), readSource: file => files[file.path] });
    const graph = buildGraph(scan.files);
    // walk calls enter through a visitor it was handed; the graph cannot name that, but readAll wrote enter and so reaches it.
    expect(graph.callees('src/read.js::readAll').sort()).toEqual(['src/read.js::readAll.enter', 'src/visit.js::walk']);
    expect(graph.isDynamic('src/read.js::readAll', 'src/read.js::readAll.enter')).toBe(true);
    expect(graph.callees('src/read.js::readAll.enter')).toEqual(['src/read.js::mark']);
  });
});

describe('what a call may run besides what it names', () => {
  async function repository(files, options = {}) {
    const { analyzeFiles } = await import('../src/analysis.js');
    const { createAnalyzer } = await import('../src/treesitter/index.ts');
    const scan = await analyzeFiles(Object.keys(files).map(path => ({ type: 'blob', path, sha: path })), { analyzer: createAnalyzer(), readSource: file => files[file.path] });
    return buildGraph(scan.files, options);
  }

  it('reaches every override of a method called on its base, anonymous classes included, and every overload of a name', async () => {
    const graph = await repository({
      'src/Adapter.java': 'public abstract class Adapter<T> {\n  public abstract void write(Writer out, T value);\n}\n',
      'src/Adapters.java': 'public class Adapters {\n  public static final Adapter<Boolean> BOOLEAN = new Adapter<Boolean>() {\n    public void write(Writer out, Boolean value) {\n      out.value(value);\n    }\n  };\n\n  static Adapter<Long> longAdapter() {\n    return new Adapter<Long>() {\n      public void write(Writer out, Long value) {\n        out.value(value);\n      }\n    };\n  }\n}\n',
      'src/Gson.java': 'public class Gson {\n  public void toJson(Object value) {\n    toJson(value, null);\n  }\n\n  public void toJson(Object value, Writer out) {\n    Adapter<Object> adapter = getAdapter(value);\n    adapter.write(out, value);\n  }\n\n  Adapter<Object> getAdapter(Object value) {\n    return null;\n  }\n}\n',
      'test/GsonTest.java': 'class GsonTest {\n  @Test\n  void writesBoolean() {\n    new Gson().toJson(true);\n  }\n}\n',
    });
    // The anonymous class a field holds is named by the field; one a method returns by the method. Each extends Adapter.
    expect(graph.files.get('src/Adapters.java').file.bases).toEqual({ 'Adapters.BOOLEAN': ['Adapter'], 'Adapters.longAdapter': ['Adapter'] });
    expect([...graph.nodes.keys()].filter(id => id.endsWith('.write'))).toEqual(['src/Adapter.java::Adapter.write', 'src/Adapters.java::Adapters.BOOLEAN.write', 'src/Adapters.java::Adapters.longAdapter.write']);
    // `adapter.write(..)` on an Adapter runs whichever adapter was built: the abstract method, and every write written for one.
    expect(graph.callees('src/Gson.java::Gson.toJson#2').sort()).toEqual(['src/Adapter.java::Adapter.write', 'src/Adapters.java::Adapters.BOOLEAN.write', 'src/Adapters.java::Adapters.longAdapter.write', 'src/Gson.java::Gson.getAdapter']);
    expect(graph.isDynamic('src/Gson.java::Gson.toJson#2', 'src/Adapters.java::Adapters.BOOLEAN.write')).toBe(true);
    expect(graph.isDynamic('src/Gson.java::Gson.toJson#2', 'src/Adapter.java::Adapter.write')).toBe(false);
    // A call by a name a class declares twice reaches both overloads whose parameters take what was passed.
    expect(graph.callees('test/GsonTest.java::GsonTest.writesBoolean').sort()).toEqual(['src/Gson.java::Gson.toJson', 'src/Gson.java::Gson.toJson#2']);
    expect(graph.isDynamic('test/GsonTest.java::GsonTest.writesBoolean', 'src/Gson.java::Gson.toJson#2')).toBe(true);
  });

  it('names a Rust impl by its type, records the trait it implements, and reaches the methods of a value handed to a call on an untyped parameter', async () => {
    const graph = await repository({
      'src/ser.rs': "pub struct Serializer<W> {\n    writer: W,\n}\n\nimpl<W> Serializer<W> {\n    pub fn new(writer: W) -> Self {\n        Serializer { writer }\n    }\n}\n\nimpl<'a, W> ser::Serializer for &'a mut Serializer<W> {\n    fn serialize_u64(self, value: u64) -> Result<()> {\n        self.writer.write(value)\n    }\n}\n\npub fn to_writer<W, T: Serialize>(writer: W, value: &T) {\n    let mut ser = Serializer::new(writer);\n    value.serialize(&mut ser);\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn writes() {\n        to_writer(Vec::new(), &1u64);\n    }\n}\n",
    });
    // The trait's methods belong to Serializer, not to `&'a mut Serializer<W>`.
    expect([...graph.nodes.keys()].filter(id => id.includes('serialize_u64'))).toEqual(['src/ser.rs::Serializer.serialize_u64']);
    expect(graph.files.get('src/ser.rs').file.bases).toEqual({ Serializer: ['Serializer'] });
    // `value.serialize(&mut ser)`: value is any T, so whatever serialize runs may call any method of the Serializer it was handed.
    expect(graph.callees('src/ser.rs::to_writer').sort()).toEqual(['src/ser.rs::Serializer.new', 'src/ser.rs::Serializer.serialize_u64']);
    expect(graph.isDynamic('src/ser.rs::to_writer', 'src/ser.rs::Serializer.serialize_u64')).toBe(true);
    expect(graph.callers('src/ser.rs::to_writer')).toEqual(['src/ser.rs::writes']);
  });

  it('reads a call on a bounded type parameter as a call on the trait, and runs every implementation', async () => {
    const graph = await repository({
      'src/read.rs': "pub trait Read<'de> {\n    fn next(&mut self) -> Option<u8>;\n}\n\npub struct SliceRead<'a> {\n    slice: &'a [u8],\n}\n\nimpl<'a> Read<'a> for SliceRead<'a> {\n    fn next(&mut self) -> Option<u8> {\n        self.slice.first().copied()\n    }\n}\n\npub struct StrRead<'a> {\n    delegate: SliceRead<'a>,\n}\n\nimpl<'a> Read<'a> for StrRead<'a> {\n    fn next(&mut self) -> Option<u8> {\n        self.delegate.next()\n    }\n}\n",
      'src/de.rs': "use crate::read::Read;\n\npub struct Deserializer<R> {\n    read: R,\n}\n\nimpl<'de, R: Read<'de>> Deserializer<R> {\n    pub fn new(read: R) -> Self {\n        Deserializer { read }\n    }\n\n    pub fn peek(&mut self) -> Option<u8> {\n        self.read.next()\n    }\n}\n\npub fn parse<V>(visitor: V) where V: Visitor {\n    visitor.visit()\n}\n",
    });
    // The field `read: R` is a Read, by R's bound; the trait declares next without a body, a declaration the call resolves to
    // that runs every implementation, as a Java abstract method does.
    expect(graph.files.get('src/de.rs').file.binds.find(item => item.name === 'this.read')).toMatchObject({ type: 'Read' });
    expect(graph.files.get('src/de.rs').file.binds.find(item => item.name === 'visitor')).toMatchObject({ type: 'Visitor' });
    expect(graph.callees('src/de.rs::Deserializer.peek').sort()).toEqual(['src/read.rs::Read.next', 'src/read.rs::SliceRead.next', 'src/read.rs::StrRead.next']);
    expect(graph.isDynamic('src/de.rs::Deserializer.peek', 'src/read.rs::Read.next')).toBe(false);
    expect(graph.isDynamic('src/de.rs::Deserializer.peek', 'src/read.rs::StrRead.next')).toBe(true);
    // A concrete field runs its own type's method, and nothing else.
    expect(graph.callees('src/read.rs::StrRead.next')).toEqual(['src/read.rs::SliceRead.next']);
  });

  it('gives a decorated definition the class its decorator makes', async () => {
    const graph = await repository({
      'cli/core.py': 'class Command:\n    def __init__(self, name, callback):\n        self.name = name\n        self.callback = callback\n\n    def main(self, args):\n        return self.callback()\n',
      'cli/decorators.py': 'from .core import Command\n\n\ndef command(name=None, cls=None):\n    if cls is None:\n        cls = Command\n\n    def decorator(f):\n        return cls(name, f)\n\n    return decorator\n',
      'cli/testing.py': 'class Runner:\n    def invoke(self, cli, args):\n        return cli.main(args)\n',
      'tests/test_cli.py': 'from cli.decorators import command\nfrom cli.testing import Runner\n\n\ndef test_hello():\n    @command()\n    def hello():\n        return 1\n\n    assert Runner().invoke(hello, []) == 1\n',
    });
    // `@command()` over `def hello()` leaves hello holding the Command the decorator built, so the runner's `cli.main` is Command's.
    expect(graph.nodes.get('tests/test_cli.py::test_hello.hello').decorators).toEqual(['command']);
    expect(graph.callees('cli/testing.py::Runner.invoke')).toEqual(['cli/core.py::Command.main']);
  });
});

