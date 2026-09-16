/** Append-only scan journal: every model call and command is memoized by key and identity. */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

async function atomicWrite(path, text) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

export async function openJournal(path) {
  await mkdir(dirname(path), { recursive: true });
  let entries = {};
  try { entries = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const persist = () => atomicWrite(path, JSON.stringify(entries, null, 2));
  return {
    path,
    get: key => entries[key]?.value,
    has: key => Object.hasOwn(entries, key),
    keys: () => Object.keys(entries),
    /** Return the stored value for key when its identity matches; run fn once otherwise. */
    async memo(key, identity, fn) {
      const entry = entries[key];
      if (entry) {
        if (entry.identity !== identity) throw new Error(`${key} identity changed`);
        return entry.value;
      }
      const value = await fn();
      entries[key] = { identity, value, at: new Date().toISOString() };
      await persist();
      return value;
    },
  };
}
