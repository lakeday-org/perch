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
