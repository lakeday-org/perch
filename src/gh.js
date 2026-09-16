/** The GitHub CLI, logged in by the operator. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function gh(args) {
  try { return (await execFileAsync('gh', args, { maxBuffer: 16 * 1024 * 1024 })).stdout; }
  catch (error) { throw new Error(`gh ${args[0]} ${args[1] ?? ''} failed: ${(error.stderr || error.message || '').toString().trim()}`); }
}

export const repoOf = github => `${github.owner}/${github.repo}`;
export const issueNumber = url => Number(/\/issues\/(\d+)/.exec(url ?? '')?.[1]) || null;
