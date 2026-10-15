/** The no-op Node script receives each supplied argument as one unchanged argv element. */
export function check_cwe78_argv(v, result) {
  if (v.case !== "exec_node_argv" || result.code === null) return;
  assert.deepStrictEqual(JSON.parse(result.output), v.args, `argv differed: input=${JSON.stringify(v.args)} output=${JSON.stringify(result.output)}`);
}

/** Shell syntax in argument values is printed as data rather than executed by a shell. */
export function check_cwe77_shell_data(v, result) {
  if (v.case !== "exec_node_argv" || result.code === null) return;
  assert.deepStrictEqual(JSON.parse(result.output), v.args, `shell-like arguments changed: input=${JSON.stringify(v.args)} output=${JSON.stringify(result.output)}`);
}

/** Option-like values remain individual arguments after the fixed Node script. */
export function check_cwe88_argument_boundaries(v, result) {
  if (v.case !== "exec_node_argv" || result.code === null) return;
  assert.deepStrictEqual(JSON.parse(result.output), v.args, `argument boundaries changed: input=${JSON.stringify(v.args)} output=${JSON.stringify(result.output)}`);
}

/** Captured output is bounded by the runner's 20,000-character tail limit. */
export function check_cwe407_bounded_output(v, result) {
  if (v.case !== "exec_node_argv") return;
  assert(result.output.length <= 20000, `captured output exceeded its limit: length=${result.output.length}`);
}