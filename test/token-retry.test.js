import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parseQuestions } from '../src/ask.js';
import { createSystemOne } from '../src/systemone.js';
import { askUnitSteps, unitSteps, locateBreak } from '../src/units.js';
import { methodSteps } from '../src/questions.js';
import { questionMethod } from '../src/scan.js';
import { scriptedSystemOne } from './helpers.js';

const reply = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body), json: async () => body });
const oversized = () => reply(422, { error: { code: 'context_length_exceeded', message: 'state plus question exceeds the token limit' } });
const rule = parseQuestions('- name: stock\n  where: example.js\n  ensure: Every order checks stock.\n', 'fixture', 'rule')[0];

it('keeps the existing CLI file and its configuration rule together', async () => {
  const source = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  const rules = parseQuestions(await readFile(new URL('../perch.yaml', import.meta.url), 'utf8'), 'perch.yaml', 'rule')
    .filter(rule => rule.name === 'cli-honors-api-configuration');
  const steps = unitSteps({ rules, unit: { path: 'src/cli.js', line: 1 }, source });
  expect(steps).toHaveLength(1);
  expect(steps[0].state.source).toBe(source);
});

it('retries an underestimated question batch without losing or changing questions', async () => {
  const sent = [];
  const questions = Object.fromEntries(['a', 'b', 'c', 'd'].map(name => [name, { type: 'noul', instructions: name }]));
  const client = createSystemOne({ apiKey: 'fixture', fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); sent.push(body);
    if (Object.keys(body.questions).length > 1) return oversized();
    return reply(200, { answers: Object.fromEntries(Object.keys(body.questions).map(name => [name, { noul: 0.9 }])), usage: { input_tokens: 10 } });
  } });
  const response = await client.ask({ source: 'function order() {}' }, questions);
  expect(Object.keys(response.answers).sort()).toEqual(['a', 'b', 'c', 'd']);
  expect(response.usage.input_tokens).toBe(40);
  expect(new Set(sent.map(body => JSON.stringify(body))).size).toBe(sent.length);
  expect(sent.every(body => Object.entries(body.questions).every(([name, question]) => JSON.stringify(question) === JSON.stringify(questions[name])))).toBe(true);
});

it('rebuilds a rejected whole-file request and preserves all source ranges', async () => {
  const source = 'export function order() { return stock; }\n'.repeat(1600);
  const prepare = budget => unitSteps({ rules: [rule], unit: { path: 'example.js', line: 1 }, source, budget });
  const accepted = [], rejected = [];
  const client = createSystemOne({ apiKey: 'fixture', fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.state.source.length > 6000) { rejected.push(body.state.source); return oversized(); }
    accepted.push(body.state.reading);
    return reply(200, { answers: { stock: { noul: 0.95 } } });
  } });
  const result = await askUnitSteps({ systemOne: client, steps: prepare(), prepare, rules: [rule] });
  expect(rejected.length).toBeGreaterThan(0);
  expect(new Set(rejected).size).toBe(rejected.length);
  expect(accepted[0].start_byte).toBe(0);
  expect(accepted.at(-1).end_byte).toBe(Buffer.byteLength(source));
  expect(result.incomplete).toBe(true);
});

it('retries oversized method readings and keeps the defect at its original line', async () => {
  const lines = ['function order() {', ...Array.from({ length: 1200 }, () => '  checkStock();'), '  return BROKEN;', '}'];
  const node = { path: 'example.js', qualified_name: 'order', line: 1, end_line: lines.length };
  const prepare = budget => methodSteps({ node, lines, budget });
  const scripted = scriptedSystemOne();
  let rejected = 0;
  const client = createSystemOne({ apiKey: 'fixture', fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.state.method.source.length > 5000) { rejected++; return oversized(); }
    const response = await scripted.ask(body.state, body.questions);
    if (body.questions.has_bug) response.answers.has_bug = { noul: body.state.method.source.includes('BROKEN') ? 0.99 : 0.01 };
    if (body.questions.where && body.state.method.source.includes('BROKEN')) response.answers.where = { choice: 'L1202', confidence: 0.99 };
    return reply(200, response);
  } });
  const result = await questionMethod({ systemOne: client, node, lines, steps: prepare(), prepare });
  expect(rejected).toBeGreaterThan(0);
  expect(result.answers.where.line).toBe(1202);
  expect(result.answers.has_bug).toBe(0.99);
});

it('retries oversized localization requests without changing the original line', async () => {
  const body = 'safe\n'.repeat(3000) + 'BROKEN\n';
  let rejected = 0;
  const client = createSystemOne({ apiKey: 'fixture', fetchImpl: async (_url, init) => {
    const { state, questions } = JSON.parse(init.body);
    if (state.source.length > 4000) { rejected++; return oversized(); }
    if (questions.has_break) return reply(200, { answers: { has_break: { noul: state.source.includes('BROKEN') ? 0.99 : 0.01 } } });
    if (questions.where_window) {
      const choice = Object.entries(questions.where_window.criteria).find(([, span]) => {
        const [start, end] = span.match(/\d+/g).map(Number); return start <= 3041 && end >= 3041;
      })?.[0];
      return reply(200, { answers: { where_window: { choice } } });
    }
    expect(questions.where.criteria).toHaveProperty('L3041');
    return reply(200, { answers: { where: { choice: 'L3041' } } });
  } });
  expect(await locateBreak({ systemOne: client, rule, unit: { path: 'example.md', line: 41 }, body })).toBe(3041);
  expect(rejected).toBeGreaterThan(0);
});

it('does not retry an unrelated validation error', async () => {
  let requests = 0;
  const client = createSystemOne({ apiKey: 'fixture', fetchImpl: async () => {
    requests++; return reply(422, { error: 'invalid criteria: expected a map' });
  } });
  await expect(client.ask({}, { q: { type: 'noul' } })).rejects.toThrow('HTTP 422');
  expect(requests).toBe(1);
});

it('stops a persistent size rejection after changing the token budget, without reporting success', async () => {
  const source = 'export function order() { return stock; }\n'.repeat(1000);
  const prepare = budget => unitSteps({ rules: [rule], unit: { path: 'example.js', line: 1 }, source, budget });
  const sent = [];
  const client = createSystemOne({ apiKey: 'fixture', fetchImpl: async (_url, init) => { sent.push(init.body); return oversized(); } });
  await expect(askUnitSteps({ systemOne: client, steps: prepare(), prepare, rules: [rule] })).rejects.toThrow(/incomplete/i);
  expect(sent.length).toBeGreaterThan(1);
  expect(sent.length).toBeLessThanOrEqual(10);
  expect(new Set(sent).size).toBe(sent.length);
});

it.each([400, 413, 422])('recognizes context-size rejection with HTTP %i', async status => {
  const sent = [];
  const client = createSystemOne({ apiKey: 'fixture', fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); sent.push(body);
    if (Object.keys(body.questions).length > 1) return reply(status, { error: 'max_tokens_exceeded' });
    return reply(200, { answers: Object.fromEntries(Object.keys(body.questions).map(name => [name, { noul: 0.9 }])) });
  } });
  const result = await client.ask({}, { a: { type: 'noul' }, b: { type: 'noul' } });
  expect(Object.keys(result.answers)).toEqual(['a', 'b']);
  expect(sent.map(body => Object.keys(body.questions).length)).toEqual([2, 1, 1]);
});
