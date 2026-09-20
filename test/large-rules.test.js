import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { makeGraphFixture, commitAll, scriptedSystemOne } from './helpers.js';
import { revision } from '../src/git.js';
import { scanRepository } from '../src/scan.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { STATE_BYTES, jsonBytes, IncompleteCheckError } from '../src/chunks.js';
import { locateBreak } from '../src/units.js';

const cleanups = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const root of cleanups.splice(0)) await rm(root, { recursive: true, force: true }); });

it('reports an oversized method request as incomplete even when other methods succeed', async () => {
  const root = await realpath(await makeGraphFixture()); cleanups.push(root);
  const client = scriptedSystemOne();
  const systemOne = { id: client.id, async ask(state, questions) {
    if (state.method?.name === 'f') throw new IncompleteCheckError('question and context are too large');
    return client.ask(state, questions);
  } };
  const run = await scanRepository({ root, revision: await revision(root), out: join(root, '.perch'), analyzer: createSourceAnalyzer(), systemOne });
  expect(run.failed).toHaveLength(1);
  expect(run.status).toBe('incomplete');
  expect(run.visited.some(method => method.status === 'read')).toBe(true);
  expect(run.incomplete).toEqual([expect.stringContaining('question and context are too large')]);
});

it('checks a file over 1 MiB in bounded requests and reports the whole-file judgment as incomplete', async () => {
  const root = await realpath(await makeGraphFixture()); cleanups.push(root);
  await mkdir(join(root, 'docs'));
  const body = '# Reference\n\n' + 'Documented behavior.\n'.repeat(60000);
  await writeFile(join(root, 'docs', 'reference.md'), body);
  await writeFile(join(root, 'perch.yaml'), '- name: prose\n  where: docs/reference.md\n  ensure: This document explains the behavior.\n');
  await commitAll(root, 'large documentation');
  const client = scriptedSystemOne();
  const sent = [];
  const systemOne = { id: client.id, async ask(state, questions) {
    expect(jsonBytes(state)).toBeLessThanOrEqual(STATE_BYTES);
    if (questions.prose) { sent.push(state.reading); return { answers: { prose: { type: 'noul', noul: 0.95 } } }; }
    return client.ask(state, questions);
  } };
  const run = await scanRepository({ root, revision: await revision(root), out: join(root, '.perch'), analyzer: createSourceAnalyzer(), systemOne });
  expect(sent.length).toBeGreaterThan(10);
  expect(sent[0].start_byte).toBe(0);
  expect(sent.at(-1).end_byte).toBe(Buffer.byteLength(body));
  expect(run.incomplete).toEqual([expect.stringContaining('whole-file conclusion was not established')]);
  expect(run.status).toBe('incomplete');
  expect(run.coverage.find(rule => rule.name === 'prose').units).toBe(1);
  vi.stubGlobal('fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    expect(jsonBytes(request.state)).toBeLessThanOrEqual(STATE_BYTES);
    return { ok: true, status: 200, json: async () => ({ answers: Object.fromEntries(Object.keys(request.questions).map(name => [name, { noul: 0.95 }])) }) };
  });
  const output = [], errors = [];
  const code = await main(['scan', root, '--filter', 'rule=prose'], {
    env: { PERCH_API_KEY: 'fixture' }, stdout: text => output.push(text), stderr: text => errors.push(text),
  });
  expect(code, JSON.stringify({output, errors})).toBe(1);
  expect(output.join('\n')).toContain('Scan incomplete');
  expect(output.join('\n')).not.toContain('nothing to report');
  expect(errors.join('\n')).toContain('whole-file conclusion was not established');
});

it('keeps the original line number when locating a problem in a later chunk', async () => {
  const body = 'safe\n'.repeat(10000) + 'BROKEN\n';
  const systemOne = { async ask(state, questions) {
    expect(jsonBytes(state)).toBeLessThanOrEqual(STATE_BYTES);
    if (questions.has_break) return { answers: { has_break: { noul: state.source.includes('BROKEN') ? 0.99 : 0.01 } } };
    expect(state.rule).toContain('No BROKEN marker');
    if (questions.where_window) {
      const wanted = 10041;
      const [choice] = Object.entries(questions.where_window.criteria).find(([, span]) => {
        const [start, end] = span.match(/\d+/g).map(Number); return start <= wanted && wanted <= end;
      });
      return { answers: { where_window: { choice } } };
    }
    expect(questions.where.criteria).toHaveProperty('L10041');
    return { answers: { where: { choice: 'L10041' } } };
  } };
  expect(await locateBreak({ systemOne, rule: { name: 'safe', text: 'No BROKEN marker' }, unit: { path: 'guide.md', line: 41 }, body })).toBe(10041);
});
