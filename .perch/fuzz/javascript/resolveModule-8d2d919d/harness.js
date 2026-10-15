import { resolveModule } from './src/graph.js';
export async function fuzz(v) {
  return resolveModule(v.fromPath, v.module, v.language, new Set(v.paths), v.crates);
}