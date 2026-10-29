import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire as requireFrom } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type Pack = typeof import('@xberg-io/tree-sitter-language-pack');

const PACK = '@xberg-io/tree-sitter-language-pack';
const require = requireFrom(import.meta.url);

/**
 * The pack's Windows addon imports napi_create_external and napi_type_tag_object from node.dll. Node.js ships no node.dll; it
 * exports N-API from node.exe, so Windows refuses to load the addon and perch stops before it reads anything
 * (xberg-io/tree-sitter-language-pack#208). The two names are the same length, so a copy of the addon with the import renamed
 * to node.exe binds to the running Node.js, which is what every node-gyp addon does. The copy is loaded in place of the pack's
 * index.js, which does nothing but load the addon and export it. A pack whose addon imports no node.dll loads as published.
 */
function load(): Pack {
  if (process.platform !== 'win32') return require(PACK);
  const addon = join(dirname(require.resolve(PACK)), `ts-pack-core-node.win32-${process.arch}-msvc.node`);
  if (!existsSync(addon)) return require(PACK);
  const bytes = readFileSync(addon);
  if (!renameImport(bytes, 'node.dll', 'node.exe')) return require(PACK);
  const copy = join(tmpdir(), `perch-${createHash('sha256').update(bytes).digest('hex')}.node`);
  // A file already at that name is loaded only if it is this copy, byte for byte: the temp directory is not perch's alone.
  if (!existsSync(copy) || !readFileSync(copy).equals(bytes)) {
    // Another perch may be writing or holding the same copy, and Windows will not replace a loaded DLL.
    const partial = `${copy}.${process.pid}`;
    writeFileSync(partial, bytes);
    try { renameSync(partial, copy); }
    catch (error) { rmSync(partial, { force: true }); if (!existsSync(copy) || !readFileSync(copy).equals(bytes)) throw error; }
  }
  const module = { exports: {} as Pack };
  process.dlopen(module, copy);
  return module.exports;
}

/**
 * Renames one DLL in a PE file's import table, in place, and says whether it found it. The new name must be no longer than the
 * old, since the string is overwritten where it sits.
 */
export function renameImport(pe: Buffer, from: string, to: string): boolean {
  if (to.length > from.length || pe.length < 0x40 || pe.toString('latin1', 0, 2) !== 'MZ') return false;
  try {
    const header = pe.readUInt32LE(0x3c);
    if (pe.toString('latin1', header, header + 4) !== 'PE\0\0') return false;
    const sections = pe.readUInt16LE(header + 6);
    const optional = header + 24;
    const wide = pe.readUInt16LE(optional) === 0x20b;
    // The import table is data directory 1, so a header that lists fewer than two has none.
    if (pe.readUInt32LE(optional + (wide ? 108 : 92)) < 2) return false;
    const directories = optional + (wide ? 112 : 96);
    const table = optional + pe.readUInt16LE(header + 20);
    // Only the part of a section that is in the file has an offset; past its raw data the loader fills in zeroes.
    const offset = (rva: number): number | undefined => {
      for (let i = 0; i < sections; i++) {
        const section = table + i * 40;
        const virtualSize = pe.readUInt32LE(section + 8), address = pe.readUInt32LE(section + 12);
        const rawSize = pe.readUInt32LE(section + 16), raw = pe.readUInt32LE(section + 20);
        if (rva >= address && rva - address < Math.min(rawSize, virtualSize || rawSize)) return rva - address + raw;
      }
      return undefined;
    };
    let descriptor = offset(pe.readUInt32LE(directories + 8));
    // Each import descriptor is 20 bytes, and an all-zero one ends the table; its fourth field is the DLL name's address.
    while (descriptor !== undefined && descriptor + 20 <= pe.length && pe.subarray(descriptor, descriptor + 20).some(byte => byte !== 0)) {
      const name = offset(pe.readUInt32LE(descriptor + 12));
      if (name !== undefined && pe.toString('latin1', name, name + from.length + 1).toLowerCase() === `${from.toLowerCase()}\0`) {
        pe.write(`${to}\0`, name, 'latin1');
        return true;
      }
      descriptor += 20;
    }
    return false;
  } catch (error) {
    // A header that points past the end of the file is not a PE this can rename anything in.
    if (error instanceof RangeError) return false;
    throw error;
  }
}

const pack: Pack = load();
export default pack;
