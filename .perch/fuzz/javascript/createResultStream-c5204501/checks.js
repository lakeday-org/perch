import assert from 'node:assert/strict';
import { createResultStream } from './src/cloud-results.js';
export async function fuzz(v) {
  const appended = [];
  const updates = [];
  const client = {
    startScan: async scan => ({ id: 'remote' }),
    appendFindings: async (id, rows) => { appended.push(rows); },
    updateScan: async (id, progress) => { updates.push(progress); },
    finishScan: async (id, finalScan) => ({ appended, updates, finalScan })
  };
  const stream = createResultStream(client, v.scan, () => {});
  if (v.rows) stream.add(v.rows);
  if (v.progress) for (const progress of v.progress) stream.progress(progress);
  return stream.finish(v.finalScan);
}
/** Each distinct finding is appended once, in first-seen order. */
export function check_cwe407_finding_order(v, result) {
  if (result instanceof Error) return;
  const rows = v.rows || [];
  const expected = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.id}\u0000${row.kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      expected.push(row);
    }
  }
  const actual = result.appended.flat();
  assert.deepStrictEqual(actual, expected, `findings differ: input=${JSON.stringify(rows)} output=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}
/** Finding batches respect the row-count and encoded-byte limits, except that one oversized row may occupy its own batch. */
export function check_cwe770_batch_limits(v, result) {
  if (result instanceof Error) return;
  for (const batch of result.appended) {
    const bytes = batch.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
    assert(batch.length <= 80, `batch exceeds 80 rows: input=${JSON.stringify(v)} batch=${JSON.stringify(batch)}`);
    assert(batch.length <= 1 || bytes <= 24 * 1024, `batch exceeds 24 KiB: input=${JSON.stringify(v)} bytes=${bytes} batch=${JSON.stringify(batch)}`);
  }
}
/** Finishing after progress updates sends the latest supplied progress value. */
export function check_latest_progress(v, result) {
  if (result instanceof Error) return;
  const progress = v.progress || [];
  if (progress.length) {
    const actual = result.updates.at(-1);
    assert.deepStrictEqual(actual, progress.at(-1), `latest progress differs: input=${JSON.stringify(progress)} output=${JSON.stringify(result.updates)}`);
  }
}