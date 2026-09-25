/** An in-memory snapshot for a directory that has no Git repository. */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createFileSelector, eligibleFile } from './exclusions.js';

const snapshots = new Map();
const hash = value => createHash('sha256').update(value).digest('hex');

export async function snapshotDirectory(root, out) {
  const tree = [];
  const output = out ? relative(root, out).split(sep).join('/') : null;
  const walk = async (directory, prefix = '') => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (output && (path === output || path.startsWith(`${output}/`))) continue;
      if (entry.isDirectory()) {
        if (eligibleFile({ type: 'blob', path: `${path}/file` })) await walk(join(directory, entry.name), path);
      } else if (entry.isFile() && !entry.name.toLowerCase().startsWith('.env')) {
        tree.push({ path, type: 'blob', mode: '100644', size: (await stat(join(directory, entry.name))).size, sha: null });
      }
    }
  };
  await walk(root);
  tree.sort((a, b) => a.path.localeCompare(b.path));
  const selected = createFileSelector(tree), blobs = new Map();
  const content = [];
  for (const file of tree) {
    if (!selected(file)) continue;
    const bytes = await readFile(join(root, file.path));
    file.sha = hash(bytes);
    blobs.set(file.sha, bytes.toString('utf8'));
    content.push([file.path, file.sha]);
  }
  const revision = `workspace:${hash(JSON.stringify(content))}`;
  snapshots.set(root, { revision, tree, blobs });
  return revision;
}

export const snapshotFor = (root, revision) => snapshots.get(root)?.revision === revision ? snapshots.get(root) : null;
export const snapshotBlob = (root, sha) => snapshots.get(root)?.blobs.get(sha);
