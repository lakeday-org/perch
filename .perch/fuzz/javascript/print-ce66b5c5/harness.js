import { jsonChunks, jsonPieces } from './src/store.js';
export async function fuzz(v) {
  if (v.case === "json_chunks") return [...jsonChunks(v.value)].join("");
  return [...jsonPieces(v.value, v.depth)].join("");
}