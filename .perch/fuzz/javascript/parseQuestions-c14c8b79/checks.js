/** The parsed list agrees with checking each declared question directly. */
export function check_questions_match_direct_check(v, result) {
  const doc = v.text.trim() ? JSON.parse(v.text) : [];
  const list = Array.isArray(doc) ? doc : doc?.rules ?? (doc && typeof doc === 'object' && ('ignore' in doc || 'scan_types' in doc) ? [] : undefined);
  assert(Array.isArray(list), `accepted document did not resolve to a question list: ${v.text}`);
  const expected = list.map((question, index) => check(question, `${v.at} ${v.noun} ${index + 1}`, v.noun));
  assert.deepStrictEqual(result, expected, `parseQuestions disagrees with direct checks for ${v.text}: ${JSON.stringify(result)} versus ${JSON.stringify(expected)}`);
}

/** Re-encoding the accepted question list as a JSON array preserves its parsed result. */
export function check_rules_wrapper_and_array_agree(v, result) {
  const doc = v.text.trim() ? JSON.parse(v.text) : [];
  const list = Array.isArray(doc) ? doc : doc?.rules ?? (doc && typeof doc === 'object' && ('ignore' in doc || 'scan_types' in doc) ? [] : undefined);
  assert(Array.isArray(list), `accepted document did not resolve to a question list: ${v.text}`);
  const equivalent = parseQuestions(JSON.stringify(list), v.at, v.noun);
  assert.deepStrictEqual(result, equivalent, `document ${v.text} and equivalent array produced ${JSON.stringify(result)} versus ${JSON.stringify(equivalent)}`);
}

/** Every returned question retains the corresponding declared input question and its position. */
export function check_cwe20_declared_questions_preserved(v, result) {
  const doc = v.text.trim() ? JSON.parse(v.text) : [];
  const list = Array.isArray(doc) ? doc : doc?.rules ?? (doc && typeof doc === 'object' && ('ignore' in doc || 'scan_types' in doc) ? [] : undefined);
  assert(Array.isArray(list), `accepted document did not resolve to a question list: ${v.text}`);
  assert.strictEqual(result.length, list.length, `question count changed for ${v.text}: ${result.length} versus ${list.length}`);
  for (let index = 0; index < list.length; index += 1) {
    assert.deepStrictEqual(result[index].declared, list[index], `question ${index} changed its declared value: ${JSON.stringify(result[index].declared)} versus ${JSON.stringify(list[index])}`);
    assert.strictEqual(result[index].at, `${v.at} ${v.noun} ${index + 1}`, `question ${index} has unexpected location ${result[index].at}`);
  }
}

/** Distinct declared question objects remain distinct and are returned in their original order. */
export function check_cwe843_question_order_and_types(v, result) {
  const doc = v.text.trim() ? JSON.parse(v.text) : [];
  const list = Array.isArray(doc) ? doc : doc?.rules ?? (doc && typeof doc === 'object' && ('ignore' in doc || 'scan_types' in doc) ? [] : undefined);
  assert(Array.isArray(list), `accepted document did not resolve to a question list: ${v.text}`);
  for (let index = 0; index < list.length; index += 1) {
    assert.deepStrictEqual(result[index].declared, list[index], `question ${index} was reinterpreted: ${JSON.stringify(result[index].declared)} versus ${JSON.stringify(list[index])}`);
  }
}