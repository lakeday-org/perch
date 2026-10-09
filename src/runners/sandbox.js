/**
 * A test run perch starts, held to the directories it may write: a mutant turns code a test runs into code nobody reviewed, and
 * a test that deletes, moves or overwrites files does so wherever the mutant points it. On macOS every run goes through
 * `sandbox-exec`, which the system ships, with writes allowed only under the copy, its scratch directory and the system's
 * temporary directory. On Linux, through bubblewrap when it is installed, with the rest of the file system read-only. With
 * neither, the run is not held, and the caller says so.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

const MACOS = '(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null") (literal "/dev/tty") (subpath "/dev/fd")';

let bubblewrap = null;
const hasBubblewrap = () => (bubblewrap ??= spawnSync('bwrap', ['--version'], { stdio: 'ignore' }).status === 0);

/** Which sandbox runs here: `macos`, `bubblewrap`, or null for none. */
export function sandboxKind() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux' && hasBubblewrap()) return 'bubblewrap';
  return null;
}

/**
 * `command` and `args` as the sandbox runs them, with writes allowed only under `writable` and the system's temporary
 * directory. Paths are resolved, since the sandbox compares the real path a write goes to.
 */
export function sandboxed(command, args, writable) {
  const dirs = [...new Set([...writable, tmpdir()].map(dir => realpathSync(dir)))];
  const kind = sandboxKind();
  if (kind === 'macos') {
    const params = dirs.flatMap((dir, at) => ['-D', `W${at}=${dir}`]);
    const profile = `${MACOS} ${dirs.map((_, at) => `(subpath (param "W${at}"))`).join(' ')})`;
    return { command: 'sandbox-exec', args: [...params, '-p', profile, command, ...args] };
  }
  if (kind === 'bubblewrap') {
    return { command: 'bwrap', args: ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', ...dirs.flatMap(dir => ['--bind', dir, dir]), '--die-with-parent', '--', command, ...args] };
  }
  return { command, args };
}
