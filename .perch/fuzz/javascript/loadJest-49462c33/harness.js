import { frameworkScope } from './src/test-scope.js';
export async function fuzz(v) {
  return await frameworkScope(v);
}