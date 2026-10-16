#!/usr/bin/env node
/** Fails the publish when an entry in package.json "exports" names a file that is not there or does not load. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
let failed = 0;

for (const [entry, target] of Object.entries(pkg.exports)) {
  try {
    const module = await import(pathToFileURL(resolve(target)).href);
    console.log(`${entry} -> ${target}: ${Object.keys(module).length} exports`);
  } catch (err) {
    failed += 1;
    console.error(`${entry} -> ${target}: ${err.message}`);
  }
}

process.exit(failed ? 1 : 0);
