import { exec, available } from './src/runners/pytest.js';
export async function fuzz(v) {
  if (v.case === "exec_node_argv") return await exec(v.command, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...v.args], { cwd: process.cwd(), env: {}, timeout: v.timeout, writable: null });
  return await available({ root: process.cwd() });
}