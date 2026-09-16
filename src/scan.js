/** `perch scan`: analyze every tracked source file at a revision and rank the files by risk. No worktree, no commands, no model. */
import { join } from 'node:path';
import { listTree, readBlobs } from './git.js';
import { analyzeFiles, sourceFile } from './analysis.js';
import { identity, openStore, readJson, writeJson } from './store.js';

export function scanIdentity({ revision, paths }) {
  return identity('scan', revision, [...paths].sort());
}

const selected = paths => file => !paths.length || paths.some(path => file.path === path || file.path.startsWith(path.replace(/\/$/, '') + '/'));

export async function runScan({ root, revision, out, analyzer, label = root, github = null, paths = [], progress = () => {}, log = () => {}, debug = () => {} }) {
  const store = openStore(out);
  const id = scanIdentity({ revision, paths });
  const dir = store.scanDir(id), scanPath = join(dir, 'scan.json');
  const existing = await readJson(scanPath, null);
  if (existing?.status === 'complete') {
    debug(`scan ${id} already complete; reusing ${scanPath}`);
    return existing;
  }
  await store.exclude(root);
  const tree = await listTree(root, revision);
  const sources = tree.filter(sourceFile).filter(selected(paths));
  if (!sources.length) throw new Error('No supported source files in this repository');
  debug(`analyzing ${sources.length} source files`);
  // Blobs stream from one git process while the analyzer works through them in order.
  const blobs = new Map(), waiting = new Map();
  const reading = readBlobs(root, sources.map(file => file.sha), (index, text) => { const wake = waiting.get(index); if (wake) { waiting.delete(index); wake(text); } else blobs.set(index, text); });
  reading.catch(error => { log(`blob reading failed: ${error.message}`); });
  const readSource = (file, index) => {
    if (blobs.has(index)) { const text = blobs.get(index); blobs.delete(index); return text; }
    return Promise.race([new Promise(resolve => waiting.set(index, resolve)), reading.then(() => { throw new Error(`Blob for ${file.path} was not delivered`); })]);
  };
  const analysis = await analyzeFiles(sources, { analyzer, readSource, progress, debug });
  await reading;
  const scan = { id, status: 'complete', target: label, github, root, revision, paths, out: dir, created_at: new Date().toISOString(),
    coverage: { ...analysis.coverage, excluded: tree.filter(item => item.type === 'blob').length - sources.length }, functions: analysis.functions, files: analysis.files, candidates: analysis.candidates };
  await writeJson(scanPath, scan);
  return scan;
}
