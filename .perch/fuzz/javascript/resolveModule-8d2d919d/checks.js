/** Reordering the indexed paths must not change which module resolves. */
export function check_path_order_invariance(v, result) {
  const reversed = resolveModule(v.fromPath, v.module, v.language, new Set([...v.paths].reverse()), v.crates);
  assert.strictEqual(reversed, result, `path-order results differ: original=${String(result)} reversed=${String(reversed)} input=${JSON.stringify(v)}`);
}

/** A resolved path must be an entry in the supplied project-path index. */
export function check_cwe22_result_is_indexed(v, result) {
  if (result !== null) assert(v.paths.includes(result), `resolver returned a path absent from the index: result=${JSON.stringify(result)} paths=${JSON.stringify(v.paths)}`);
}

/** A non-string module is rejected with the resolver's null result, not interpreted as a valid module name. */
export function check_cwe755_non_string_module(v, result) {
  if (typeof v.module !== "string") assert.strictEqual(result, null, `non-string module was not rejected: module=${JSON.stringify(v.module)} result=${JSON.stringify(result)}`);
}

/** A non-string module must not be accepted as a valid module path. */
export function check_cwe20_non_string_module(v, result) {
  if (typeof v.module !== "string") assert.strictEqual(result, null, `unexpected module type resolved: module=${JSON.stringify(v.module)} result=${JSON.stringify(result)}`);
}

/** Equivalent JavaScript relative spellings with redundant current-directory segments resolve identically. */
export function check_cwe180_js_dot_segment(v, result) {
  if (v.case !== "js_relative" || !v.module.startsWith("./")) return;
  const equivalent = `././${v.module.slice(2)}`;
  const transformed = resolveModule(v.fromPath, equivalent, v.language, new Set(v.paths), v.crates);
  assert.strictEqual(transformed, result, `equivalent module spellings differ: original=${JSON.stringify(v.module)} result=${String(result)} transformed=${JSON.stringify(equivalent)} transformedResult=${String(transformed)}`);
}

/** An unlisted sibling must not resolve merely because its name is requested directly. */
export function check_cwe425_unlisted_sibling(v, result) {
  if (v.case === "js_unlisted") assert.strictEqual(result, null, `unlisted sibling resolved: module=${JSON.stringify(v.module)} paths=${JSON.stringify(v.paths)} result=${String(result)}`);
}