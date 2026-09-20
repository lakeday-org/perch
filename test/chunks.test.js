import { describe, expect, it } from 'vitest';
import { sourceChunks, questionBatches } from '../src/chunks.js';
import { methodSteps, STATE_BUDGET } from '../src/questions.js';
import { unitSteps } from '../src/units.js';
import { createSystemOne } from '../src/systemone.js';
import { createMeter, metered } from '../src/meter.js';
import { createSourceAnalyzer, sourceFile } from '../src/analysis.js';

const bytes = value => Buffer.byteLength(JSON.stringify(value));

describe('large source reads', () => {
  it('covers every byte of a 16 MiB single-line source using bounded native chunks', () => {
    const source = 'const content = "' + 'x'.repeat(16 * 1024 * 1024) + '";';
    const chunks = sourceChunks(source, { path: 'large.js', maxBytes: 12000 });
    expect(chunks.length).toBeGreaterThan(1000);
    expect(chunks[0].startByte).toBe(0);
    expect(chunks.at(-1).endByte).toBe(Buffer.byteLength(source));
    const original = Buffer.from(source);
    let end = 0;
    for (const chunk of chunks) {
      expect(chunk.startByte).toBeLessThanOrEqual(end);
      expect(Buffer.byteLength(chunk.source)).toBeLessThanOrEqual(12000);
      expect(chunk.source).toBe(original.subarray(chunk.startByte, chunk.endByte).toString());
      end = chunk.endByte;
    }
  }, 30000);

  it('keeps UTF-8 positions and covers prose as well as code', () => {
    const source = '# Guide\n\n' + 'Résumé: 日本語 😀.\n'.repeat(5000);
    const chunks = sourceChunks(source, { path: 'guide.md', maxBytes: 1000 });
    const original = Buffer.from(source);
    for (const chunk of chunks) {
      expect(chunk.source).not.toContain('�');
      expect(chunk.source).toBe(original.subarray(chunk.startByte, chunk.endByte).toString());
      expect(chunk.line).toBe(original.subarray(0, chunk.startByte).toString().split('\n').length);
    }
    expect(chunks.at(-1).endByte).toBe(original.length);
  });

  it('reads a huge one-line method without exceeding the request state budget', () => {
    const source = 'function big() { return "' + 'x'.repeat(180000) + '"; }';
    const steps = methodSteps({ node: { path: 'big.js', qualified_name: 'big', line: 1, end_line: 1 }, lines: [source] });
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.at(-1).covers.end_byte).toBe(Buffer.byteLength(source));
    for (const step of steps) expect(bytes(step.state)).toBeLessThanOrEqual(STATE_BUDGET);
  });

  it('does not discard a source file solely because it exceeds 1 MiB', () => {
    expect(sourceFile({ path: 'src/large.py', type: 'blob', size: 16 * 1024 * 1024 })).toBe(true);
  });

  it('preserves Unicode function and call locations with the native parser', async () => {
    const source = '// 😀\nfunction run() { return next(); }';
    const result = await createSourceAnalyzer().analyzeSource(source, 'javascript');
    expect(result.parser_status).toBe('parsed');
    expect(result.declarations[0].location.start.byte).toBe(Buffer.byteLength('// 😀\n'));
    expect(result.references.find(reference => reference.name === 'next')).toMatchObject({ line: 2, source: `function:${Buffer.byteLength('// 😀\n')}` });
  });
});

describe('complete request budgets', () => {
  it('shrinks file chunks to account for JSON escaping and a long rule', () => {
    const source = '"\\'.repeat(60000);
    const rules = [{ name: 'q', type: 'noul', ask: 'Check this rule. '.repeat(1500) }];
    const steps = unitSteps({ rules, unit: { path: 'large.txt', line: 1 }, source });
    expect(steps.at(-1).chunk.endByte).toBe(Buffer.byteLength(source));
    expect(steps.length).toBeGreaterThan(1);
    for (const step of steps) expect(() => questionBatches(step.state, step.questions)).not.toThrow();
  });

  it('reserves room for long method questions before choosing source chunks', () => {
    const source = 'function big() { return "' + 'x'.repeat(50000) + '"; }';
    const asked = [{ name: 'q', type: 'noul', ask: 'Check this rule. '.repeat(1500) }];
    const steps = methodSteps({ node: { path: 'big.js', qualified_name: 'big', line: 1, end_line: 1 }, lines: [source], asked });
    expect(steps.at(-1).covers.end_byte).toBe(Buffer.byteLength(source));
    for (const step of steps) expect(() => questionBatches(step.state, step.questions)).not.toThrow();
  });

  it('batches long questions and accounts for the source in every outgoing request', async () => {
    const sent = [];
    const client = createSystemOne({ apiKey: 'fixture', fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      sent.push(request);
      return { ok: true, status: 200, json: async () => ({ answers: Object.fromEntries(Object.keys(request.questions).map(name => [name, { noul: 0.9 }])), usage: { input_tokens: 100 } }) };
    } });
    const questions = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'x'.repeat(4000) }]));
    const meter = createMeter();
    const result = await metered(client, meter).ask({ source: 'x'.repeat(20000) }, questions);
    expect(Object.keys(result.answers)).toHaveLength(30);
    expect(sent.length).toBeGreaterThan(1);
    expect(meter.toJSON()['jev-latest']).toMatchObject({ requests: sent.length, input: 100 * sent.length });
    for (const request of sent) {
      expect(bytes(request.state) + bytes(request.questions)).toBeLessThanOrEqual(64000);
      for (const question of Object.values(request.questions)) expect(bytes(request.state) + bytes(question)).toBeLessThanOrEqual(32000);
    }
  });

  it('rejects unchunked oversized state before making an HTTP request', async () => {
    let sent = 0;
    const client = createSystemOne({ apiKey: 'fixture', fetchImpl: async () => { sent++; throw new Error('must not send'); } });
    await expect(client.ask({ source: 'x'.repeat(40000) }, { q: { type: 'noul' } })).rejects.toThrow(/too large|incomplete/i);
    expect(sent).toBe(0);
  });
});

it('budgets the line labels when a method has thousands of very short lines', () => {
  const lines = Array.from({ length: 12000 }, () => 'x;');
  const steps = methodSteps({ node: { path: 'tall.js', qualified_name: 'tall', line: 1, end_line: lines.length }, lines });
  expect(steps.at(-1).covers.end_line).toBe(lines.length);
  for (const step of steps) expect(bytes(step.state)).toBeLessThanOrEqual(STATE_BUDGET);
});
