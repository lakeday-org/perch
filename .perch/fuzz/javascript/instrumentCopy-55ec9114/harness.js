import { instrument } from './src/runners/schemata.js';
export async function fuzz(v) {
  return instrument({ source: v.source, language: v.language, mutants: v.mutants, prelude: v.prelude, head: v.head });
}