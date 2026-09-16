/** A detached worktree for one fix: dependencies linked from the operator's checkout when present, scripts run inside it, removed afterwards. */
import { existsSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { addWorktree, removeWorktree } from './git.js';

export const COMMAND_MS = 5 * 60_000, INSTALL_MS = 20 * 60_000;
const linkable = ['node_modules', '.venv', 'target', 'vendor'];
/** perch's own configuration never reaches a test run: model-written tests must not see credentials, and a project's tests must not read perch's .env. */
export const WITHHELD = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'TYPESAFE_API_KEY'];
export const workspaceEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([key]) => !WITHHELD.includes(key)));

export async function openWorkspace({ root, revision, dir, shell, log = () => {} }) {
  log(`checking out ${revision.slice(0, 12)} into ${dir}`);
  await addWorktree(root, dir, revision);
  const linked = [];
  for (const name of linkable) {
    if (existsSync(join(root, name)) && !existsSync(join(dir, name))) { await symlink(join(root, name), join(dir, name)); linked.push(name); }
  }
  return {
    dir,
    linked,
    run: (script, timeoutMs = COMMAND_MS) => shell.run(script, { cwd: dir, timeoutMs, env: workspaceEnv() }),
    close: () => removeWorktree(root, dir),
  };
}
