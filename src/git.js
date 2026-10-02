/** Thin git wrapper; hooks are disabled so the operator's global hook path never runs. */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch (error) {
    const detail = (error.stderr || error.message || '').toString().trim();
    const failure = new Error(`git ${args.filter(arg => !arg.startsWith('-c') || arg.length > 2).join(' ')} failed: ${detail}`);
    failure.stdout = error.stdout?.toString() ?? '';
    throw failure;
  }
}

export const repoRoot = dir => git(['rev-parse', '--show-toplevel'], dir).then(text => text.trim());
export const revision = (root, ref = 'HEAD') => git(['rev-parse', '--verify', `${ref}^{commit}`], root).then(text => text.trim());
export const originUrl = root => git(['remote', 'get-url', 'origin'], root).then(text => text.trim()).catch(() => null);

/** Tracked blobs at a revision with their sizes. */
export async function listTree(root, rev) {
  const text = await git(['ls-tree', '-r', '-l', '-z', rev], root);
  return text.split('\0').filter(Boolean).map(entry => {
    const match = /^(\d+) (\w+) ([0-9a-f]+) +(\d+|-)\t(.*)$/s.exec(entry);
    if (!match) throw new Error(`Unexpected ls-tree entry: ${entry}`);
    return { mode: match[1], type: match[2], sha: match[3], size: match[4] === '-' ? 0 : Number(match[4]), path: match[5] };
  });
}

/** The content of one tracked blob, read without a checkout. */
export const readBlob = (root, sha) => git(['cat-file', 'blob', sha], root);

/** Git writes a decimal blob length before its bytes; refuse lengths JavaScript cannot index exactly. */
export function batchBlobSize(header, prefixBytes) {
  const match = /^[0-9a-f]+ blob ([0-9]+)$/.exec(header);
  const size = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(size) || !Number.isSafeInteger(prefixBytes + size + 1)) {
    throw new Error(`git cat-file --batch returned an invalid blob header: ${header}`);
  }
  return size;
}

/** `git cat-file --batch` output cut back into blobs: `onBlob(text)` for each one whole, `onMissing(header)` for one git lacks. */
function batchParser(onBlob, onMissing) {
  let pending = Buffer.alloc(0);
  // Chunks of a blob not yet whole, joined once it is. Joining every chunk onto what came before copied a large blob once per
  // chunk of it: a 64 MB file took three seconds to read, and each doubling took four times as long.
  let held = [], heldBytes = 0, wanted = 0;
  const drain = () => {
    for (;;) {
      const newline = pending.indexOf(10);
      if (newline < 0) { wanted = 0; return; }
      const header = pending.subarray(0, newline).toString();
      if (header.endsWith(' missing')) { pending = pending.subarray(newline + 1); onMissing(header); continue; }
      const size = batchBlobSize(header, newline + 1);
      if (pending.length < newline + 1 + size + 1) { wanted = newline + 1 + size + 1; return; }
      onBlob(pending.subarray(newline + 1, newline + 1 + size).toString('utf8'));
      pending = pending.subarray(newline + 1 + size + 1);
    }
  };
  return chunk => {
    held.push(chunk); heldBytes += chunk.length;
    if (pending.length + heldBytes < wanted) return;
    pending = Buffer.concat([pending, ...held]); held = []; heldBytes = 0;
    drain();
  };
}

/**
 * Blobs read when asked for, all through one `git cat-file --batch` process started on the first read. Git answers in the order
 * it was asked, so each answer goes to the oldest read still waiting. A process per blob ran perch out of open files on a method
 * with a few hundred callers. `close` lets git exit once it has answered what it was asked; a read after that fails.
 */
export function openBlobReader(root) {
  let running = null, closed = false;
  const start = () => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', 'cat-file', '--batch'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    const waiting = [];
    let stderr = '', broken = false;
    const fail = error => {
      if (running?.child === child) running = null;
      for (const read of waiting.splice(0)) read.reject(error);
    };
    const take = batchParser(text => waiting.shift().resolve(text), header => waiting.shift().reject(new Error(`git cat-file: ${header}`)));
    // A process that failed to start has no pipes; its 'error' says why.
    child.stdout?.on('data', chunk => {
      if (broken) return;
      try { take(chunk); } catch (error) { broken = true; child.kill(); fail(error); }
    });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.stdin?.on('error', () => {});
    child.on('error', error => fail(new Error(`git cat-file --batch failed: ${error.message}`)));
    child.on('close', code => fail(new Error(`git cat-file --batch failed: ${stderr.trim() || `exited with ${code} and ${waiting.length} blobs unread`}`)));
    return { child, waiting };
  };
  return {
    read(sha) {
      if (closed) return Promise.reject(new Error('git cat-file --batch was already closed'));
      running ??= start();
      const { child, waiting } = running;
      return new Promise((resolve, reject) => { waiting.push({ resolve, reject }); child.stdin?.write(`${sha}\n`); });
    },
    close() { closed = true; running?.child.stdin?.end(); running = null; },
  };
}

/** Many blobs through one `git cat-file --batch` process, delivered in order to `onBlob(index, text)`. */
export async function readBlobs(root, shas, onBlob) {
  const blobs = openBlobReader(root);
  try { await Promise.all(shas.map((sha, index) => blobs.read(sha).then(text => onBlob(index, text)))); }
  finally { blobs.close(); }
}

/** A path as git prints it in a diff: quoted, with C escapes, when it holds anything unusual. */
const diffPath = text => (text.startsWith('"') ? JSON.parse(text.replace(/\\([0-7]{3})/g, (_, octal) => `\\u00${parseInt(octal, 8).toString(16).padStart(2, '0')}`)) : text);

/**
 * The lines a branch added or changed: for every file the diff from the merge base with `since` to `rev` touches, the line numbers
 * in `rev` that are new or different. A file the branch deleted has none; a renamed file is under its new path. Lines are read
 * from the hunk headers of a zero-context diff, which is exactly the set git itself calls changed.
 */
export async function changedLines(root, since, rev = 'HEAD') {
  const base = (await git(['merge-base', since, rev], root)).trim();
  const text = await git(['-c', 'core.quotePath=false', 'diff', '--unified=0', '--no-color', '--no-ext-diff', '-M', `${base}..${rev}`], root);
  const files = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = diffPath(line.slice(4).trimEnd());
      current = path === '/dev/null' ? null : path.replace(/^b\//, '');
      if (current && !files.has(current)) files.set(current, []);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !current) continue;
    const start = Number(hunk[1]), count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let number = start; number < start + count; number++) files.get(current).push(number);
  }
  return { base, files };
}
