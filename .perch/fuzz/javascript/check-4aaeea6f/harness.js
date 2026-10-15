import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTarget } from './src/check.js';
import { createSourceAnalyzer } from './src/analysis.js';
export async function fuzz(v) {
  const root = await mkdtemp(join(tmpdir(), 'perch-check-'));
  try {
    await writeFile(join(root, 'input.md'), v.text, 'utf8');
    return await checkTarget({ target: 'input.md', root, out: join(root, 'out'), analyzer: createSourceAnalyzer(), systemOne: { id: 'fuzz', limits: {}, ask: async () => { throw new Error('unexpected model request'); } }, revision: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}