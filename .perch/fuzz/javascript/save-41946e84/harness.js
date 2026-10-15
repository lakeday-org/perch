import { addRule, editRule, removeRule } from './src/rules.js';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const observations = new WeakMap();

async function snapshot(directory) {
  const found = new Map();
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) found.set(full, `link:${await import('node:fs/promises').then(fs => fs.readlink(full))}`);
      else if (info.isDirectory()) await walk(full);
      else found.set(full, await readFile(full));
    }
  }
  await walk(directory);
  return found;
}

export async function fuzz(v) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'perch-rules-'));
  const root = path.join(workspace, 'base', 'project');
  await mkdir(root, { recursive: true });
  const outside = path.join(workspace, 'outside');
  await mkdir(outside);
  const sentinel = path.join(outside, 'sentinel.yml');
  const initial = '- name: sample\n';
  await writeFile(sentinel, initial);
  let file;
  if (v.attack === 'parent_symlink') {
    const outsideDirectory = path.join(outside, 'linked');
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, path.join(root, 'linked'));
    file = path.join(root, 'linked', 'rules.yml');
    await writeFile(file, initial);
  } else {
    file = path.resolve(root, v.file);
    await mkdir(path.dirname(file), { recursive: true });
    if (v.attack === 'symlink') {
      await symlink(sentinel, file);
    } else if (v.attack === 'hardlink') {
      await link(sentinel, file);
    } else {
      await writeFile(file, initial);
    }
  }
  const before = await snapshot(workspace);
  let result;
  try {
    if (v.case === 'add_rule') result = await addRule(root, v.rule, { file });
    else if (v.case === 'edit_rule') result = await editRule(root, v.name, v.changes, { file });
    else result = await removeRule(root, v.name, { file });
  } finally {
    const after = await snapshot(workspace);
    const changed = [];
    for (const [name, contents] of after) {
      const old = before.get(name);
      if (old === undefined || (Buffer.isBuffer(old) && Buffer.isBuffer(contents) ? !old.equals(contents) : old !== contents)) changed.push(name);
    }
    for (const name of before.keys()) if (!after.has(name)) changed.push(name);
    observations.set(v, { workspace, root, sentinel, sentinelBefore: before.get(sentinel), changed });
  }
  return result;
}