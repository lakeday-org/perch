/** `perch scan`: analyze every source file at a revision, or in a directory without Git, and rank the files by risk. No model. */
import { join } from 'node:path';
import { listTree, readBlobs } from './git.js';
import { analyzeFiles, sourceFile } from './analysis.js';
import { createFileSelector, EXCLUSIONS_PROFILE } from './exclusions.js';
import { ANALYSIS_PROFILE } from './treesitter/types.ts';
import { identity, openStore, readJson, writeJson } from './store.js';

export function scanIdentity({ revision, paths }) {
  return identity('scan', ANALYSIS_PROFILE, EXCLUSIONS_PROFILE, revision, [...paths].sort());
}

const selected = paths => file => !paths.length || paths.some(path => file.path === path || file.path.startsWith(path.replace(/\/$/, '') + '/'));

export async function analyzeTree({ root, revision, out, analyzer, label = root, github = null, paths = [], progress = () => {}, log = () => {}, debug = () => {} }) {
  const store = openStore(out);
  const id = scanIdentity({ revision, paths });
  const dir = store.scanDir(id), scanPath = join(dir, 'scan.json');
  // A parse is local work the model never sees, and perch issues parses on every call to tell which findings still exist. The
  // same commit and paths parse the same way, so a finished one is the answer.
  const existing = await readJson(scanPath, null);
  if (existing?.status === 'complete') {
    debug(`scan ${id} already complete; reusing ${scanPath}`);
    return existing;
  }
  await store.exclude(root);
  const tree = await listTree(root, revision);
  const sources = tree.filter(createFileSelector(tree)).filter(sourceFile).filter(selected(paths));
  if (!sources.length) throw new Error('No supported source files in this project');
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
  await store.prune('scans', id).catch(error => log(`Could not remove earlier scans: ${error.message}`));
  return scan;
}
