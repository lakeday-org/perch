import { resolveTarget } from './src/check.js';
import { analyzeFiles, createSourceAnalyzer } from './src/analysis.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function fuzz(v) {
  const analyzer = createSourceAnalyzer();
  if (v.case === 'analyze_files') return await analyzeFiles([{ type: 'blob', path: v.path, sha: v.path, language: 'javascript' }], { analyzer, readSource: async () => v.text });
  const root = await mkdtemp(join(tmpdir(), 'filegraph-fuzz-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, v.target.split('::')[0]), v.text, 'utf8');
    return await resolveTarget({ target: v.target, root, out: join(root, '.perch'), analyzer });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}