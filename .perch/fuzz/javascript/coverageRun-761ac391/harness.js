import { jvmRunner } from './src/runners/jvm.js';
export async function fuzz(v) {
  return jvmRunner(v);
}