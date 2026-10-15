/** Graph nodes produced by resolveTarget correspond to the methods found by analyzing the same source. */
export async function check_graph_matches_analysis(v, result) {
  if (v.case === 'analyze_files') return;
  const analysis = await analyzeFiles([{ type: 'blob', path: v.target.split('::')[0], sha: v.target.split('::')[0], language: 'javascript' }], { analyzer: createSourceAnalyzer(), readSource: async () => v.text });
  if (analysis.coverage.parsed !== 1) return;
  const expected = analysis.files[0].methods.map(method => method.id).sort();
  const actual = [...result.graph.nodes.keys()].sort();
  assert.deepStrictEqual(actual, expected, `resolveTarget graph node ids ${JSON.stringify(actual)} differ from analyzed method ids ${JSON.stringify(expected)} for ${JSON.stringify(v)}`);
}

/** Every recorded graph edge has an existing target, a reverse caller entry, and a source site. */
export function check_graph_edges_are_consistent(v, result) {
  if (v.case === 'analyze_files') return;
  const graph = result.graph;
  let edges = 0;
  for (const [from, node] of graph.nodes) {
    assert.strictEqual(node.id, from, `node key ${from} differs from node id ${node.id} for ${JSON.stringify(v)}`);
    for (const to of graph.callees(from)) {
      edges += 1;
      assert(graph.nodes.has(to), `edge ${from} -> ${to} has no target node for ${JSON.stringify(v)}`);
      assert(graph.callers(to).includes(from), `edge ${from} -> ${to} is missing from callers for ${JSON.stringify(v)}`);
      assert.notStrictEqual(graph.site(from, to), null, `edge ${from} -> ${to} has no source site for ${JSON.stringify(v)}`);
    }
  }
  assert.strictEqual(graph.edgeCount(), edges, `edgeCount ${graph.edgeCount()} differs from enumerated edge count ${edges} for ${JSON.stringify(v)}`);
}

/** Analysis accounts for the single supplied file as either parsed or failed, never silently losing it. */
export function check_cwe755_single_file_accounted_for(v, result) {
  if (v.case !== 'analyze_files') return;
  const accounted = result.coverage.parsed + result.coverage.parse_failures;
  assert.strictEqual(accounted, 1, `analysis accounted for ${accounted} files rather than one for ${JSON.stringify(v)}: ${JSON.stringify(result.coverage)}`);
  assert.strictEqual(result.files.length, result.coverage.parsed, `analysis returned ${result.files.length} file records for ${result.coverage.parsed} parsed files for ${JSON.stringify(v)}`);
}

/** Parsed declaration counts remain bounded by the bytes of source supplied. */
export function check_cwe400_declarations_bounded(v, result) {
  const count = v.case === 'analyze_files' ? result.functions : result.graph.nodes.size;
  const bytes = Buffer.byteLength(v.text);
  assert(count <= bytes + 1, `reported ${count} declarations for ${bytes} source bytes in ${JSON.stringify(v)}`);
}

/** A successful target lookup stays at the requested in-repository path and preserves its source text. */
export function check_cwe20_target_stays_at_requested_path(v, result) {
  if (v.case === 'analyze_files') return;
  const path = v.target.split('::')[0];
  assert.strictEqual(result.path, path, `resolved path ${result.path} differs from requested path ${path} for ${JSON.stringify(v)}`);
  assert.strictEqual(result.text, v.text, `resolved source text differs from supplied text for ${JSON.stringify(v)}`);
  assert(!result.path.startsWith('/') && !result.path.split('/').includes('..'), `resolved path ${result.path} escapes the supplied repository for ${JSON.stringify(v)}`);
}

/** The fixed method target resolves to the requested entry declaration. */
export function check_cwe20_method_target_matches_result(v, result) {
  if (v.case !== 'resolve_target_method') return;
  assert.strictEqual(result.name, 'entry', `accepted method target ${v.target} resolved to ${result.name} for ${JSON.stringify(v)}`);
  assert(result.id.endsWith('::entry'), `accepted method target ${v.target} returned id ${result.id} for ${JSON.stringify(v)}`);
}