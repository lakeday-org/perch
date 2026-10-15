import { instrument } from './src/runners/schemata.js';
export async function fuzz(v) {
  const result = instrument(v.source);
  return result.locate(v.line, v.column);
}

/** Re-instrumenting the same source and querying the same position produces the same marker IDs. */
export function check_repeat_is_deterministic(v, result) {
  const repeated = instrument(v.source).locate(v.line, v.column);
  assert.deepStrictEqual(result, repeated, `input ${JSON.stringify(v)} produced ${JSON.stringify(result)} on the first call and ${JSON.stringify(repeated)} on the repeated call`);
}
/** Every returned marker ID is a nonnegative safe integer present in the instrumented text. */
export function check_cwe129_returned_ids_are_marked(v, result) {
  const text = instrument(v.source).text;
  const markedIds = new Set();
  for (const match of text.matchAll(/\/\*(?:<(\d+)|\[([\d,]+))\*\//g)) {
    if (match[1] !== undefined) {
      markedIds.add(Number(match[1]));
    } else {
      for (const id of match[2].split(',')) markedIds.add(Number(id));
    }
  }
  for (const id of result) {
    assert(Number.isSafeInteger(id) && id >= 0 && markedIds.has(id), `input ${JSON.stringify(v)} returned ID ${id}, which is not a nonnegative safe integer marked in the instrumented text`);
  }
}