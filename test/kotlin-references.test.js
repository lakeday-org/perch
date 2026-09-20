import { expect, it, vi } from 'vitest';
import pack from '@xberg-io/tree-sitter-language-pack';
import { createAnalyzer } from '../src/treesitter/index.ts';
import { analyzeFiles } from '../src/analysis.js';
import { buildGraph } from '../src/graph.js';

const analyzer = createAnalyzer();
it('names bare, member, safe-navigation, generic and trailing-lambda calls without inventing dynamic targets', async () => {
  const source = 'fun run() {\n helper()\n this.helper()\n other?.helper()\n helper<Int>()\n items.map { helper() }\n factory()()\n}\n';
  const result = await analyzer.analyzeSource(source,'kotlin');
  expect(result.parser_status).toBe('parsed');
  expect(result.references.filter(ref=>ref.kind==='call').map(ref=>ref.reference).sort()).toEqual([
    'helper','this.helper','other.helper','helper','items.map','helper','factory','<dynamic>',
  ].sort());
});

it('gives property lambdas stable names and connects their calls in the graph', async () => {
  const source = 'class K {\n val first = { helper() }\n val second: () -> Int = { helper() }\n val wrapped = ({ helper() })\n fun helper() = 1\n fun run() { first(); second(); wrapped() }\n}\n';
  const result = await analyzer.analyzeSource(source,'kotlin');
  expect(result.parser_status).toBe('parsed');
  expect(result.declarations.map(item=>item.qualified_name)).toEqual(['K.first','K.second','K.wrapped','K.helper','K.run']);
  const scan = await analyzeFiles([{path:'App.kt',sha:'fixture'}],{analyzer,readSource:async()=>source});
  const graph = buildGraph(scan.files);
  expect(graph.callees('App.kt::K.run').sort()).toEqual(['App.kt::K.first','App.kt::K.second','App.kt::K.wrapped']);
  for (const name of ['first','second','wrapped']) expect(graph.callees(`App.kt::K.${name}`)).toEqual(['App.kt::K.helper']);
});

it('reports rescued Kotlin syntax consistently and preserves genuine diagnostics', async () => {
  for (const source of ['class K { fun compute() }','class K { fun compute() { helper() } }']) {
    const result=await analyzer.analyzeSource(source,'kotlin');
    expect(result.parser_status).toBe('parsed');
    expect(result.diagnostics).toEqual([]);
    expect(result.parser_message).toBeNull();
  }
  const malformed=await analyzer.analyzeSource('class K { fun broken( }','kotlin');
  expect(malformed.parser_status).toBe('parse-error');
  expect(malformed.diagnostics.length).toBeGreaterThan(0);
  expect(malformed.parser_message).toBeTruthy();
});

it('drops a pack diagnostic for the Kotlin separator that Perch has accepted', async () => {
  const process=pack.process.bind(pack);
  const diagnostic=vi.spyOn(pack,'process').mockImplementation((source,options)=>({
    ...process(source,options), diagnostics:[{message:'Missing _automatic_semicolon',severity:'Error'}],
  }));
  try {
    const result=await analyzer.analyzeSource('class K { fun compute() }','kotlin');
    expect(result.parser_status).toBe('parsed');
    expect(result.diagnostics).toEqual([]);
    expect(result.parser_message).toBeNull();
  } finally { diagnostic.mockRestore(); }
});
