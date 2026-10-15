import { javascriptRunner } from './src/runners/javascript.js';
export async function fuzz(v) {
  return await javascriptRunner.coverageRun(v);
}