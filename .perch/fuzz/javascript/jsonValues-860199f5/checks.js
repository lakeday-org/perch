/** Adding whitespace around complete package objects preserves the parsed values. */
export function check_whitespace_invariance(v, result) {
  const changed = goRunner(` \n${v.text}\n `);
  assert.deepStrictEqual(changed, result, `Whitespace changed the result: input=${JSON.stringify(v.text)} original=${JSON.stringify(result)} changed=${JSON.stringify(changed)}`);
}

/** Braces inside JSON strings do not alter the package boundaries. */
export function check_cwe436_braces_in_strings(v, result) {
  const changedText = v.text.replaceAll("}", "} {");
  const changed = goRunner(changedText);
  assert.deepStrictEqual(changed, result, `Braces in strings changed parsed values: input=${JSON.stringify(v.text)} original=${JSON.stringify(result)} changed=${JSON.stringify(changed)}`);
}

/** Parsed package data contains only ordinary JSON values and does not pollute object prototypes. */
export function check_cwe502_plain_json_data(v, result) {
  if (!Array.isArray(result)) return;
  const visit = value => {
    if (value === null || typeof value !== "object") return;
    assert(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype, `Unexpected prototype in result ${JSON.stringify(result)} for input ${JSON.stringify(v.text)}`);
    for (const child of Object.values(value)) visit(child);
  };
  for (const value of result) visit(value);
}