import { cargoRunner } from './src/runners/cargo.js';
export async function fuzz(v) {
  return await cargoRunner(v);
}