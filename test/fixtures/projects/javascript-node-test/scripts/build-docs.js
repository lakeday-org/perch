#!/usr/bin/env node
/**
 * Writes the configuration reference from a schema file: node scripts/build-docs.js stratum.schema.json docs/configuration.md
 */
import { readFile, writeFile } from 'node:fs/promises';
import { Schema } from '../src/index.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: build-docs.js <schema.json> <output.md>');
  process.exit(2);
}

const schema = new Schema(JSON.parse(await readFile(input, 'utf8')));
const rows = schema.describe().map(row => `| \`${row.key}\` | ${row.type} | ${row.required ? 'yes' : ''} | ${row.default === undefined ? '' : `\`${JSON.stringify(row.default)}\``} | ${row.doc} |`);

await writeFile(output, ['# Configuration', '', '| Key | Type | Required | Default | |', '| --- | --- | --- | --- | --- |', ...rows, ''].join('\n'));
console.log(`wrote ${rows.length} keys to ${output}`);
