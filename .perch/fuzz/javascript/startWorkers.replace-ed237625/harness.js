import { startWorkers } from './src/runners/workers.js';
export async function fuzz(v) {
  throw new Error('Cannot safely reach startWorkers.replace: the available path starts and replaces OS child processes, which this harness must not spawn.');
}