/** Joining jsonChunks output agrees with jsonPieces at depth zero. */
export function check_json_chunks_agree(v, result) {
  if (v.case !== "json_chunks") return;
  const pieces = [...jsonPieces(v.value, 0)].join("");
  assert.strictEqual(result, pieces, `jsonChunks output ${JSON.stringify(result)} differs from jsonPieces output ${JSON.stringify(pieces)} for ${JSON.stringify(v.value)}`);
}
/** jsonPieces output equals pretty-printed JSON with the requested indentation offset. */
export function check_json_pieces_serialization(v, result) {
  if (v.case !== "json_pieces") return;
  const serialized = JSON.stringify(v.value, null, 2);
  const expected = serialized.replaceAll("\n", `\n${"  ".repeat(v.depth)}`);
  assert.strictEqual(result, expected, `jsonPieces output ${JSON.stringify(result)} differs from expected ${JSON.stringify(expected)} for ${JSON.stringify(v.value)}`);
}