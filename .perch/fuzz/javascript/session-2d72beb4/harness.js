import { goRunner } from './src/runners/go.js';
export async function fuzz(v) {
  return await goRunner(v);
}