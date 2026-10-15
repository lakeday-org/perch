/** Both JSONL write methods preserve supplied JSON rows in order. */
export function check_jsonl_round_trip(v, result) {
  if (v.case !== 'append_read_lines' && v.case !== 'write_read_lines') return;
  assert.deepStrictEqual(result.rows, v.rows, `JSONL round trip changed rows: input=${JSON.stringify(v.rows)} output=${JSON.stringify(result.rows)}`);
  assert.deepStrictEqual(result.alternate, v.rows, `alternate JSONL method changed rows: input=${JSON.stringify(v.rows)} output=${JSON.stringify(result.alternate)}`);
}

/** Append and atomic-write JSONL methods agree on the same input rows. */
export function check_jsonl_methods_differential(v, result) {
  if (v.case !== 'append_read_lines' && v.case !== 'write_read_lines') return;
  assert.deepStrictEqual(result.rows, result.alternate, `JSONL methods disagree: append/write results=${JSON.stringify(result.rows)} / ${JSON.stringify(result.alternate)}, input=${JSON.stringify(v.rows)}`);
}

/** The number of parsed JSONL rows follows the number actually supplied. */
export function check_cwe770_jsonl_rows_track_supplied_rows(v, result) {
  if (v.case !== 'append_read_lines' && v.case !== 'write_read_lines') return;
  assert.strictEqual(result.rows.length, v.rows.length, `JSONL output count differs from supplied count: input count=${v.rows.length}, output count=${result.rows.length}`);
}

/** JSONL output preserves the supplied sequence rather than changing its order. */
export function check_cwe407_jsonl_order(v, result) {
  if (v.case !== 'append_read_lines' && v.case !== 'write_read_lines') return;
  assert.deepStrictEqual(result.rows, v.rows, `JSONL order/data changed: input=${JSON.stringify(v.rows)}, output=${JSON.stringify(result.rows)}`);
}

/** JSONL parsing treats dangerous-looking property names as serialized data. */
export function check_cwe502_serialized_keys_are_data(v, result) {
  if (v.case !== 'append_read_lines' && v.case !== 'write_read_lines') return;
  assert.deepStrictEqual(result.rows, v.rows, `JSONL deserialization changed input data: input=${JSON.stringify(v.rows)}, output=${JSON.stringify(result.rows)}`);
}

/** Pruning a symlink entry does not change the content of its outside target. */
export function check_cwe59_prune_preserves_external_target(v, result) {
  if (v.case !== 'symlink_prune') return;
  assert.strictEqual(result.sentinel, 'unchanged', `external symlink target changed: id=${v.id}, result=${JSON.stringify(result)}`);
}

/** Exclusion applies only when the output path is below the root at a slash boundary. */
export function check_cwe187_exclude_segment_boundary(v, result) {
  if (v.case !== 'exclude_boundary') return;
  const expected = v.suffix === '/child';
  assert.strictEqual(result.content !== null, expected, `exclude boundary mismatch: root=${v.rootName}, suffix=${JSON.stringify(v.suffix)}, content=${JSON.stringify(result.content)}`);
}

/** Pruning keeps the selected ordinary run and scan directories and removes the other directories. */
export function check_prune_selected_directories(v, result) {
  if (v.case !== 'prune_directories') return;
  const expected = [`keep_${v.id}`];
  assert.deepStrictEqual(result.runs, expected, `run prune mismatch: id=${v.id}, expected=${JSON.stringify(expected)}, actual=${JSON.stringify(result.runs)}`);
  assert.deepStrictEqual(result.scans, expected, `scan prune mismatch: id=${v.id}, expected=${JSON.stringify(expected)}, actual=${JSON.stringify(result.scans)}`);
}

/** A positive log-tail limit includes the final line written. */
export function check_log_tail_includes_last_line(v, result) {
  if (v.case !== 'start_log_tail' || v.count === 0) return;
  assert(result.some(line => line.endsWith(` ${v.last}`)), `tail omitted final line: input=${JSON.stringify(v)}, output=${JSON.stringify(result)}`);
}

/** A missing JSONL file is read as an empty sequence. */
export function check_missing_jsonl_is_empty(v, result) {
  if (v.case !== 'read_missing_lines') return;
  assert.deepStrictEqual(result, [], `missing JSONL output differs: output=${JSON.stringify(result)}`);
}

/** A dismissal event retains its finding ID and appears in the closure index. */
export function check_dismissal_is_indexed(v, result) {
  if (v.case !== 'decide_closure' || v.type !== 'dismissed') return;
  assert.strictEqual(result.event.id, v.finding.id, `dismissal event ID mismatch: finding=${JSON.stringify(v.finding)}, event=${JSON.stringify(result.event)}`);
  assert(result.closures.some(([id]) => id === v.finding.id), `dismissal absent from closure index: finding=${JSON.stringify(v.finding)}, closures=${JSON.stringify(result.closures)}`);
}

/** Recorded scan rows preserve order and indexes retain the last qualifying event for each key. */
export function check_scan_indexes(v, result) {
  if (v.case !== 'record_scan_indexes') return;
  assert.deepStrictEqual(result.rows, v.rows, `scan rows changed: input=${JSON.stringify(v.rows)}, output=${JSON.stringify(result.rows)}`);
  const latest = new Map();
  const checks = new Map();
  for (const event of v.rows) {
    if (event.rule) checks.set(event.id, event);
    else if (event.id && event.answers_set) latest.set(event.method, event);
  }
  assert.deepStrictEqual(result.latest, [...latest.entries()], `method index mismatch: expected=${JSON.stringify([...latest.entries()])}, actual=${JSON.stringify(result.latest)}`);
  assert.deepStrictEqual(result.checks, [...checks.entries()], `rule index mismatch: expected=${JSON.stringify([...checks.entries()])}, actual=${JSON.stringify(result.checks)}`);
}

/** A unique ID lookup returns the event with the requested ID. */
export function check_unique_finding_lookup(v, result) {
  if (v.case !== 'find_finding_unique') return;
  assert.strictEqual(result.id, v.id, `unique lookup returned a different ID: requested=${v.id}, result=${JSON.stringify(result)}`);
}

/** The latest scan query returns the scan record stored for its scan directory. */
export function check_latest_scan_record(v, result) {
  if (v.case !== 'query_scan_issues') return;
  assert.deepStrictEqual(result.latestScan, v.scan, `latest scan differs: input=${JSON.stringify(v.scan)}, output=${JSON.stringify(result.latestScan)}`);
}