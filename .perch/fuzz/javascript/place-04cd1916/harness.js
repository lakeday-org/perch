import { addRule } from './src/rules.js';
import { editRule } from './src/rules.js';
import { removeRule } from './src/rules.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export async function fuzz(v) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rules-fuzz-'));
  try {
    await writeFile(path.join(root, 'perch.yaml'), v.doc, 'utf8');
    if (v.case === 'add_rule') return await addRule(root, v.rule, { file: 'perch.yaml' });
    if (v.case === 'edit_rule') return await editRule(root, v.name, v.changes, { file: 'perch.yaml' });
    return await removeRule(root, v.name, { file: 'perch.yaml' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
/** Appending a final newline to a rule document does not change the operation result. */
export async function check_trailing_newline_invariance(v, result) {
  const other = await fuzz({ ...v, doc: `${v.doc}\n` });
  assert.deepStrictEqual(other, result, `appending a newline changed the result: input=${JSON.stringify(v)}, original=${JSON.stringify(result)}, changed=${JSON.stringify(other)}`);
}
/** Repeating an operation on the same input produces the same result. */
export async function check_deterministic_result(v, result) {
  const other = await fuzz(v);
  assert.deepStrictEqual(other, result, `repeated operation differed: input=${JSON.stringify(v)}, first=${JSON.stringify(result)}, second=${JSON.stringify(other)}`);
}
/** Processing larger rule documents completes within a generous bound consistent with input size. */
export async function check_cwe400_bounded_processing(v, result) {
  const start = performance.now();
  await fuzz(v);
  const elapsed = performance.now() - start;
  assert(Number.isFinite(elapsed) && elapsed < 30000, `processing time was not finite or exceeded the bound: elapsed=${elapsed}, input=${JSON.stringify(v)}, result=${JSON.stringify(result)}`);
}
/** Adding many independent block rules does not cause an extreme increase in processing time. */
export async function check_cwe407_scaling(v, result) {
  if (!v.doc.startsWith('- name: ')) return;
  const one = `- name: scalea\n  description: item\n  pattern: "item"\n`;
  const many = Array.from({ length: 64 }, (_, i) => `- name: scale${i}x\n  description: item\n  pattern: "item"\n`).join('');
  const smallStart = performance.now();
  await fuzz(v);
  const small = performance.now() - smallStart;
  const largeStart = performance.now();
  await fuzz({ ...v, doc: `${v.doc}${many}` });
  const large = performance.now() - largeStart;
  assert(Number.isFinite(small) && Number.isFinite(large) && large < small * 12 + 500, `document growth caused an unexpectedly large time increase: small=${small}, large=${large}, input=${JSON.stringify(v)}, result=${JSON.stringify(result)}, addedRule=${one}`);
}