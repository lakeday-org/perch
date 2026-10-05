/** `perch scan`: analyze every tracked source file at a revision and rank the files by risk. No model. */
import { availableParallelism } from 'node:os';
import { git, listTree, readBlobs } from './git.js';
import { analyzeFiles, METHOD_HASH, sourceFile } from './analysis.js';
import { createFileSelector, EXCLUSIONS_PROFILE } from './exclusions.js';
import { PARSE_VERSION } from './treesitter/types.ts';
import { identity, openStore, readScan, writeScan } from './store.js';
import { markTestSupport } from './test-scope.js';

export function scanIdentity({ revision, paths }) {
  return identity('scan', PARSE_VERSION, EXCLUSIONS_PROFILE, METHOD_HASH, revision, [...paths].sort());
}

const selected = paths => file => !paths.length || paths.some(path => file.path === path || file.path.startsWith(path.replace(/\/$/, '') + '/'));

/** A crate's name and lib.rs from its Cargo.toml: `[lib] name` or `[package] name`, a hyphen in either written as an underscore in code. */
export function crateOf(path, text) {
  const section = name => text.match(new RegExp(`^\\[${name}\\]([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm'))?.[1] ?? '';
  const field = (body, key) => body.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1] ?? null;
  const name = field(section('lib'), 'name') ?? field(section('package'), 'name');
  if (!name) return null;
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const lib = field(section('lib'), 'path');
  return { name: name.replaceAll('-', '_'), root: dir, lib: lib ? (dir ? `${dir}/${lib}` : lib) : `${dir ? `${dir}/` : ''}src/lib.rs` };
}

/**
 * Each Rust crate's name and where it is: `serde_json::from_str` in a test names the crate by its Cargo.toml, not by a path, so
 * the call graph needs the name to find the crate's lib.rs.
 */
async function cratesOf(root, revision, tree) {
  const crates = [];
  for (const item of tree.filter(entry => entry.type === 'blob' && /(^|\/)Cargo\.toml$/.test(entry.path))) {
    // The tree lists it at this revision, so a failure to show it is git failing, not a crate that is not there.
    const crate = crateOf(item.path, await git(['show', `${revision}:${item.path}`], root));
    if (crate) crates.push(crate);
  }
  return crates;
}

export async function analyzeTree({ root, revision, out, analyzer, label = root, github = null, paths = [], progress = () => {}, log = () => {}, debug = () => {} }) {
  const store = openStore(out);
  const id = scanIdentity({ revision, paths });
  const dir = store.scanDir(id);
  // A parse is local work the model never sees, and perch issues parses on every call to tell which findings still exist. The
  // same commit and paths parse the same way, so a finished one is the answer.
  const existing = await readScan(dir);
  if (existing?.status === 'complete') {
    debug(`scan ${id} already complete; reusing ${dir}`);
    return existing;
  }
  await store.exclude(root);
  const tree = await listTree(root, revision);
  const sources = tree.filter(createFileSelector(tree)).filter(sourceFile).filter(selected(paths));
  // A repository with no code still has files a rule can be about: a docs-only repository scans zero methods, not an error.
  debug(`analyzing ${sources.length} source files`);
  // Blobs stream from one git process while the analyzer works through them in order.
  const blobs = new Map(), waiting = new Map();
  const reading = readBlobs(root, sources.map(file => file.sha), (index, text) => { const wake = waiting.get(index); if (wake) { waiting.delete(index); wake(text); } else blobs.set(index, text); });
  reading.catch(error => { log(`blob reading failed: ${error.message}`); });
  const readSource = (file, index) => {
    if (blobs.has(index)) { const text = blobs.get(index); blobs.delete(index); return text; }
    return Promise.race([new Promise(resolve => waiting.set(index, resolve)), reading.then(() => { throw new Error(`Blob for ${file.path} was not delivered`); })]);
  };
  // One thread a core, less the one reading blobs and keeping count.
  const analysis = await analyzeFiles(sources, { analyzer, readSource, progress, debug, workers: availableParallelism() - 1 });
  await reading;
  await markTestSupport({ root, paths: tree.filter(item => item.type === 'blob').map(item => item.path), files: analysis.files });
  const scan = { id, status: 'complete', target: label, github, root, revision, paths, out: dir, created_at: new Date().toISOString(),
    coverage: { ...analysis.coverage, excluded: tree.filter(item => item.type === 'blob').length - sources.length }, functions: analysis.functions, files: analysis.files, candidates: analysis.candidates,
    crates: await cratesOf(root, revision, tree) };
  await writeScan(dir, scan);
  await store.prune('scans', id).catch(error => log(`Could not remove earlier scans: ${error.message}`));
  return scan;
}
