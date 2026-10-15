/**
 * A file checked by the public proxy remains identified by its in-root relative path.
 */
export function check_cwe22_file_path(v, result) {
  assert.strictEqual(result.path, 'input.md', `input text ${JSON.stringify(v.text)} produced path ${JSON.stringify(result.path)}, expected the in-root input.md`);
}