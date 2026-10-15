import { buildGraph } from './src/graph.js';
function makeGraph(v, duplicateCall = false) {
  const files = v.files.map(file => ({
    ...file,
    imports: file.imports ?? [],
    methods: file.methods ?? [],
    binds: file.binds ?? [],
    bases: file.bases ?? {},
    calls: (file.calls ?? []).filter(call => call.from !== v.from)
  }));
  let file = files.find(item => item.path === v.file_path);
  if (!file) {
    file = {
      path: v.file_path,
      language: files[0]?.language ?? 'javascript',
      imports: [],
      package: '',
      methods: [],
      binds: [],
      bases: {},
      calls: []
    };
    files.push(file);
  }
  if (!file.methods.some(method => method.id === v.from)) {
    file.methods.push({id: v.from, qualified_name: 'Resolver.invoke', params: []});
  }
  const call = {name: v.name, from: v.from, line: 1, args: [], named: {}, via: v.via, depth: v.depth};
  file.calls.push(call);
  if (duplicateCall) file.calls.push({...call});
  return buildGraph(files);
}
export async function fuzz(v) {
  const graph = makeGraph(v);
  return graph.callees(v.from);
}
/** Every reported callee is a method node in the input graph. */
export function check_cwe755_results_are_nodes(v, result) {
  const ids = new Set(v.files.flatMap(file => (file.methods ?? []).map(method => method.id)));
  ids.add(v.from);
  for (const id of result) assert(ids.has(id), `reported callee is not an input method node: input=${JSON.stringify(v)} result=${JSON.stringify(result)} id=${JSON.stringify(id)}`);
}
/** The caller and callee views describe the same resolved edges. */
export function check_edge_views_agree(v, result) {
  const graph = makeGraph(v);
  for (const id of result) assert(graph.callers(id).includes(v.from), `callee view has an edge missing from caller view: input=${JSON.stringify(v)} callees=${JSON.stringify(result)} id=${JSON.stringify(id)} callers=${JSON.stringify(graph.callers(id))}`);
}
/** Repeating an identical call does not add duplicate graph edges. */
export function check_duplicate_call_invariance(v, result) {
  const repeated = makeGraph(v, true).callees(v.from);
  assert.deepStrictEqual([...repeated].sort(), [...result].sort(), `duplicate call changed the resolved edge set: input=${JSON.stringify(v)} once=${JSON.stringify(result)} twice=${JSON.stringify(repeated)}`);
}
/** Resolution results stay finite and cannot outnumber the method nodes available to resolve. */
export function check_cwe674_bounded_resolution(v, result) {
  const methodCount = v.files.reduce((count, file) => count + (file.methods ?? []).length, 0) + 1;
  assert(Array.isArray(result) && result.length <= methodCount, `resolution result is not bounded by available method nodes: input=${JSON.stringify(v)} result=${JSON.stringify(result)} methodCount=${methodCount}`);
  assert(result.every(id => typeof id === 'string' && id.length > 0), `resolution produced a missing or non-string node id: input=${JSON.stringify(v)} result=${JSON.stringify(result)}`);
}