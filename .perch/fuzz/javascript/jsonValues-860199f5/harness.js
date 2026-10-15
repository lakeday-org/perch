import { goRunner } from './src/runners/go.js';
export async function fuzz(v) {
  return goRunner(v.text);
}