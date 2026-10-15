/** A leading BOM and an appended comment do not change a successfully resolved environment. */
export async function check_comment_bom_invariance(v, result) {
  if (v.case === 'configured_environment_missing' || v.case === 'configured_environment_read_error') return;
  const content = v.content.startsWith('\uFEFF') ? v.content : '\uFEFF' + v.content;
  const transformed = await runConfigured(content + '\n# metamorphic comment', v.env, 'file');
  assert.deepStrictEqual(transformed, result, `original ${JSON.stringify(v.content)} yielded ${JSON.stringify(result)}; BOM/comment variant ${JSON.stringify(content + '\n# metamorphic comment')} yielded ${JSON.stringify(transformed)}`);
}
/** Every successful config read consists only of unique recognized quoted assignments, comments, and blank lines with nonempty resolved setting values. */
export function check_cwe20_valid_config(v, result) {
  if (v.case === 'configured_environment_missing' || v.case === 'configured_environment_read_error') return;
  const allowed = new Set(['api_key', 'base_url', 'organization', 'root']);
  const seen = new Set();
  for (const [index, raw] of v.content.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-z_]+)\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$/.exec(line);
    assert(match && allowed.has(match[1]), `successful result ${JSON.stringify(result)} came from invalid line ${index + 1}: ${JSON.stringify(raw)}`);
    assert(!seen.has(match[1]), `successful result ${JSON.stringify(result)} came from duplicate setting ${match[1]} on line ${index + 1}`);
    seen.add(match[1]);
    const value = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2].slice(1, -1);
    assert(typeof value === 'string' && value.trim().length > 0, `successful result ${JSON.stringify(result)} came from empty setting ${match[1]} on line ${index + 1}: ${JSON.stringify(value)}`);
  }
}
/** Nonempty caller environment values take precedence over config defaults. */
export function check_cwe843_environment_override(v, result) {
  for (const key of ['PERCH_API_KEY', 'PERCH_BASE_URL', 'PERCH_ORGANIZATION', 'PERCH_ROOT']) {
    if (v.env[key]) assert.strictEqual(result[key], v.env[key], `environment ${key}=${JSON.stringify(v.env[key])} was replaced; result was ${JSON.stringify(result)}`);
  }
}
/** Config-derived values are strings and cannot be longer than the document that supplied them. */
export function check_cwe400_bounded_config_values(v, result) {
  if (v.case === 'configured_environment_missing' || v.case === 'configured_environment_read_error') return;
  for (const key of ['PERCH_API_KEY', 'PERCH_BASE_URL', 'PERCH_ORGANIZATION', 'PERCH_ROOT']) {
    if (typeof result[key] === 'string' && result[key] !== v.env[key]) {
      assert(result[key].length <= v.content.length, `config-derived ${key}=${JSON.stringify(result[key])} exceeds content length ${v.content.length} for ${JSON.stringify(v.content)}`);
    }
  }
}
/** Config processing does not modify shared prototypes or return prototype-related settings. */
export function check_cwe1321_prototype_unchanged(v, result) {
  assert.strictEqual(Object.prototype.polluted, undefined, `input ${JSON.stringify(v.content)} left Object.prototype.polluted=${JSON.stringify(Object.prototype.polluted)}`);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.strictEqual(Object.hasOwn(result, key), false, `result ${JSON.stringify(result)} unexpectedly has own key ${key}`);
  }
}
/** Config resolution returns no fields outside the caller environment and the four recognized settings. */
export function check_cwe200_no_unexpected_environment_fields(v, result) {
  const allowed = new Set(['PERCH_API_KEY', 'PERCH_BASE_URL', 'PERCH_ORGANIZATION', 'PERCH_ROOT']);
  for (const key of Object.keys(result)) {
    assert(allowed.has(key), `result ${JSON.stringify(result)} exposes unexpected field ${key}`);
  }
}
/** Config and environment settings remain scalar strings rather than being reinterpreted as other data types. */
export function check_cwe502_string_values_only(v, result) {
  for (const key of ['PERCH_API_KEY', 'PERCH_BASE_URL', 'PERCH_ORGANIZATION', 'PERCH_ROOT']) {
    if (Object.hasOwn(result, key)) {
      assert.strictEqual(typeof result[key], 'string', `result field ${key}=${JSON.stringify(result[key])} is not a string`);
    }
  }
}