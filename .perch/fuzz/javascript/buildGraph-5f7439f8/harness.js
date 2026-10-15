import { buildGraph } from './src/graph.js';
export async function fuzz(v) {
  return buildGraph(v.files, { crates: v.crates, modules: v.modules });
}

/** Rebuilding the same extracted metadata preserves graph nodes and observable queries. */
export function check_cwe755_deterministic_rebuild(v, result) {
  const again = buildGraph(v.files, { crates: v.crates, modules: v.modules });
  assert.deepStrictEqual([...again.nodes], [...result.nodes], `node records differ after rebuild: ${JSON.stringify([...result.nodes])} versus ${JSON.stringify([...again.nodes])}`);
  for (const id of result.nodes.keys()) {
    assert.deepStrictEqual(again.callees(id), result.callees(id), `callees differ for ${JSON.stringify(id)}: ${JSON.stringify(result.callees(id))} versus ${JSON.stringify(again.callees(id))}`);
    assert.deepStrictEqual(again.callers(id), result.callers(id), `callers differ for ${JSON.stringify(id)}: ${JSON.stringify(result.callers(id))} versus ${JSON.stringify(again.callers(id))}`);
    assert.deepStrictEqual(again.reads(id), result.reads(id), `reads differ for ${JSON.stringify(id)}: ${JSON.stringify(result.reads(id))} versus ${JSON.stringify(again.reads(id))}`);
    assert.deepStrictEqual(again.external(id), result.external(id), `external calls differ for ${JSON.stringify(id)}: ${JSON.stringify(result.external(id))} versus ${JSON.stringify(again.external(id))}`);
    assert.deepStrictEqual(again.mocks(id), result.mocks(id), `mocks differ for ${JSON.stringify(id)}: ${JSON.stringify(result.mocks(id))} versus ${JSON.stringify(again.mocks(id))}`);
  }
}
/** Each recorded edge has a matching reverse edge, and edgeCount counts the enumerated callee edges. */
export function check_cwe187_edge_consistency(v, result) {
  const ids = new Set(result.nodes.keys());
  if (ids.size !== result.nodes.size) return;
  for (const file of v.files) {
    if (file.calls.some(call => !ids.has(call.from))) return;
    if (file.methods.some(method => method.parent != null && !ids.has(method.parent))) return;
    if (file.values.some(value => !ids.has(value.from))) return;
  }
  let count = 0;
  for (const id of ids) {
    const callees = result.callees(id);
    count += callees.length;
    for (const to of callees) {
      assert(ids.has(to), `edge ${JSON.stringify(id)} -> ${JSON.stringify(to)} targets no indexed node`);
      assert(result.callers(to).includes(id), `callee edge ${JSON.stringify(id)} -> ${JSON.stringify(to)} is missing from callers(${JSON.stringify(to)})`);
    }
    for (const from of result.callers(id)) {
      assert(ids.has(from), `caller edge ${JSON.stringify(from)} -> ${JSON.stringify(id)} starts at no indexed node`);
      assert(result.callees(from).includes(id), `caller edge ${JSON.stringify(from)} -> ${JSON.stringify(id)} is missing from callees(${JSON.stringify(from)})`);
    }
  }
  assert.strictEqual(result.edgeCount(), count, `edgeCount ${result.edgeCount()} differs from enumerated callee edges ${count}`);
}
/** An unrelated empty file does not alter existing graph nodes or their adjacency. */
export function check_cwe41_unrelated_file_invariance(v, result) {
  let path = '__fuzz_unrelated_empty_graph_file__.js';
  while (v.files.some(file => file.path === path)) path = `_${path}`;
  const extra = { path, language: 'javascript', methods: [], calls: [], imports: [] };
  const again = buildGraph([...v.files, extra], { crates: v.crates, modules: v.modules });
  for (const [id, node] of result.nodes) {
    assert.deepStrictEqual(again.nodes.get(id), node, `unrelated file changed node ${JSON.stringify(id)}: ${JSON.stringify(node)} versus ${JSON.stringify(again.nodes.get(id))}`);
    assert.deepStrictEqual(again.callees(id), result.callees(id), `unrelated file changed callees for ${JSON.stringify(id)}: ${JSON.stringify(result.callees(id))} versus ${JSON.stringify(again.callees(id))}`);
    assert.deepStrictEqual(again.callers(id), result.callers(id), `unrelated file changed callers for ${JSON.stringify(id)}: ${JSON.stringify(result.callers(id))} versus ${JSON.stringify(again.callers(id))}`);
  }
}
/** Adding a longer near-match name does not change resolution of an existing simple-name call. */
export function check_cwe187_exact_name_resolution(v, result) {
  const ids = new Set(result.nodes.keys());
  for (const file of v.files) {
    for (const call of file.calls) {
      if (!ids.has(call.from) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(call.name)) continue;
      const suffix = '__prefix_probe__';
      const probeId = `__probe_${file.path}_${call.line}`;
      if (ids.has(probeId)) continue;
      const methods = [...file.methods, {
        id: probeId,
        qualified_name: `${call.name}${suffix}`,
        name: `${call.name}${suffix}`,
        params: [],
        line: call.line + 1,
        test: false,
        support: false,
        parent: null,
        returns: null,
        yields: null,
        decorators: [],
        extension: false,
        internal: false
      }];
      const changed = v.files.map(item => item === file ? { ...item, methods } : item);
      const again = buildGraph(changed, { crates: v.crates, modules: v.modules });
      assert.deepStrictEqual(again.callees(call.from), result.callees(call.from), `near-prefix method ${JSON.stringify(call.name + suffix)} changed resolution of ${JSON.stringify(call.name)} from ${JSON.stringify(result.callees(call.from))} to ${JSON.stringify(again.callees(call.from))}`);
      return;
    }
  }
}
/** Relative JavaScript import spellings with a redundant current-directory segment resolve identically. */
export function check_cwe41_relative_import_equivalence(v, result) {
  let changedAny = false;
  const files = v.files.map(file => {
    if (!['javascript', 'typescript', 'tsx'].includes(file.language)) return file;
    let changed = false;
    const imports = file.imports.map(item => {
      if (!item.module.startsWith('./') && !item.module.startsWith('../')) return item;
      changed = true;
      changedAny = true;
      return { ...item, module: `./${item.module}` };
    });
    return changed ? { ...file, imports } : file;
  });
  if (!changedAny) return;
  const again = buildGraph(files, { crates: v.crates, modules: v.modules });
  for (const id of result.nodes.keys()) {
    assert.deepStrictEqual(again.callees(id), result.callees(id), `equivalent relative import spelling changed callees for ${JSON.stringify(id)}: ${JSON.stringify(result.callees(id))} versus ${JSON.stringify(again.callees(id))}`);
    assert.deepStrictEqual(again.callers(id), result.callers(id), `equivalent relative import spelling changed callers for ${JSON.stringify(id)}: ${JSON.stringify(result.callers(id))} versus ${JSON.stringify(again.callers(id))}`);
  }
}
/** With valid unique node references, graph edges cannot exceed the number of distinct directed non-self node pairs. */
export function check_cwe400_valid_reference_edge_bound(v, result) {
  const ids = new Set(result.nodes.keys());
  if (ids.size !== result.nodes.size) return;
  for (const file of v.files) {
    if (file.calls.some(call => !ids.has(call.from))) return;
    if (file.methods.some(method => method.parent != null && !ids.has(method.parent))) return;
    if (file.values.some(value => !ids.has(value.from))) return;
  }
  const maximum = ids.size * Math.max(0, ids.size - 1);
  assert(result.edgeCount() <= maximum, `valid-reference graph has ${result.edgeCount()} edges, exceeding ${maximum} possible directed non-self edges for ${ids.size} nodes`);
}
/** Nested held values and ordinary metadata still produce finite query results when the graph call succeeds. */
export function check_cwe674_finite_nested_queries(v, result) {
  const ids = new Set(result.nodes.keys());
  for (const id of ids) {
    const callees = result.callees(id);
    const callers = result.callers(id);
    assert(Array.isArray(callees), `callees(${JSON.stringify(id)}) is not an array: ${JSON.stringify(callees)}`);
    assert(Array.isArray(callers), `callers(${JSON.stringify(id)}) is not an array: ${JSON.stringify(callers)}`);
    assert(callees.every(to => ids.has(to)), `callees(${JSON.stringify(id)}) contains an unindexed target: ${JSON.stringify(callees)}`);
    assert(callers.every(from => ids.has(from)), `callers(${JSON.stringify(id)}) contains an unindexed source: ${JSON.stringify(callers)}`);
    assert(Array.isArray(result.reads(id)), `reads(${JSON.stringify(id)}) is not an array: ${JSON.stringify(result.reads(id))}`);
    assert(Array.isArray(result.external(id)), `external(${JSON.stringify(id)}) is not an array: ${JSON.stringify(result.external(id))}`);
  }
}