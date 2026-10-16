/**
 * What each fixture application's twelve tests are expected to be, written by reading the fixture: test/fixtures/<app>/expected.json.
 * An application is a directory here with an expected.json in it, so adding a framework's fixture is adding a directory.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixtures = fileURLToPath(new URL('./', import.meta.url));

/** Every fixture application with expectations, by name, in name order: `[{ app, tests: [...] }]`. */
export async function expectations() {
  const apps = [];
  for (const entry of (await readdir(fixtures, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const text = await readFile(join(fixtures, entry.name, 'expected.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (text !== null) apps.push({ app: entry.name, ...JSON.parse(text) });
  }
  return apps;
}
