import { runnersFor } from './src/runners/index.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function fuzz(v) {
  const root = await mkdtemp(join(tmpdir(), 'runners-for-'));
  try {
    const devDependencies = Object.fromEntries(v.dev.map(name => [name, '1']));
    const dependencies = Object.fromEntries(v.prod.map(name => [name, '1']));
    await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies, dependencies }));
    const frameworks = v.frameworks.map(({ name, tests }) => ({ name, tests }));
    const nodes = new Map();
    const files = new Map();
    v.nodes.forEach((item, index) => {
      const path = `test-${index}.${item.language}`;
      nodes.set(`test-${index}`, { path, case: { framework: item.framework } });
      files.set(path, { file: { language: item.language } });
    });
    const graph = { nodes, files };
    return await runnersFor({ scope: { frameworks }, root, graph });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}