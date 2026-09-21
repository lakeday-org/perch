import { describe, expect, it } from 'vitest';
import { sourceChunks } from '../src/chunks.js';
import { TOKEN_LIMITS, estimateTokens, textTokens, questionBatches } from '../src/tokens.js';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { methodStep, methodSteps, STATE_BUDGET } from '../src/questions.js';
import { unitSteps } from '../src/units.js';
import { createSystemOne } from '../src/systemone.js';
import { createMeter, metered } from '../src/meter.js';
import { createSourceAnalyzer, sourceFile } from '../src/analysis.js';

const tokens = value => countTokens(JSON.stringify(value), { disallowedSpecial: new Set() });

describe('large source reads', () => {
  it('covers every byte of a 16 MiB single-line source using bounded native chunks', () => {
    const source = 'const content = "' + 'x'.repeat(16 * 1024 * 1024) + '";';
    const chunks = sourceChunks(source, { path: 'large.js', maxTokens: 12000 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startByte).toBe(0);
    expect(chunks.at(-1).endByte).toBe(Buffer.byteLength(source));
    const original = Buffer.from(source);
    let end = 0;
    for (const chunk of chunks) {
      expect(chunk.startByte).toBeLessThanOrEqual(end);
      expect(textTokens(chunk.source)).toBeLessThanOrEqual(12000);
      expect(chunk.source).toBe(original.subarray(chunk.startByte, chunk.endByte).toString());
      end = chunk.endByte;
    }
  }, 30000);

  it('terminates when a split lands inside an emoji or a CJK character', () => {
    // overlapStart skipped forward past continuation bytes, which could land exactly on `high`; then neither branch moved the
    // range and the search spun for good. A README with emoji big enough to chunk hung the scan on CPU with no output.
    const line = 'line N 😀😀😀 中文 🚀 text\n';
    const source = Array.from({ length: 400 }, (_, i) => line.replace('N', String(i))).join('');
    for (const maxTokens of [64, 100, 200]) {
      const chunks = sourceChunks(source, { path: 'a.md', maxTokens });
      expect(chunks.length).toBeGreaterThan(1);
      // Every chunk is still whole UTF-8: re-encoding what was decoded gives the bytes back.
      for (const chunk of chunks) expect(Buffer.from(chunk.source).length).toBe(chunk.endByte - chunk.startByte);
    }
  });

  it('keeps UTF-8 positions and covers prose as well as code', () => {
    const source = '# Guide\n\n' + 'Résumé: 日本語 😀.\n'.repeat(5000);
    const chunks = sourceChunks(source, { path: 'guide.md', maxTokens: 1000 });
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
    for (const step of steps) expect(estimateTokens(step.state)).toBeLessThanOrEqual(STATE_BUDGET);
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
    const asked = [{ name: 'q', type: 'noul', ask: 'Check this rule. '.repeat(5500) }];
    const steps = methodSteps({ node: { path: 'big.js', qualified_name: 'big', line: 1, end_line: 1 }, lines: [source], asked });
    expect(steps.length).toBeGreaterThan(1);
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
    const questions = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'check this code carefully. '.repeat(1500) }]));
    const meter = createMeter();
    const result = await metered(client, meter).ask({ source: 'x'.repeat(20000) }, questions);
    expect(Object.keys(result.answers)).toHaveLength(30);
    expect(sent.length).toBeGreaterThan(1);
    expect(meter.toJSON()['jev-latest']).toMatchObject({ requests: sent.length, input: 100 * sent.length });
    for (const request of sent) {
      expect(tokens(request.state) + tokens(request.questions)).toBeLessThanOrEqual(64000);
      for (const question of Object.values(request.questions)) expect(tokens(request.state) + tokens(question)).toBeLessThanOrEqual(32000);
    }
  });

  it('rejects unchunked oversized state before making an HTTP request', async () => {
    let sent = 0;
    const client = createSystemOne({ apiKey: 'fixture', fetchImpl: async () => { sent++; throw new Error('must not send'); } });
    await expect(client.ask({ source: 'x '.repeat(40000) }, { q: { type: 'noul' } })).rejects.toThrow(/token budget|incomplete/i);
    expect(sent).toBe(0);
  });
});

it('budgets the line labels when a method has thousands of very short lines', () => {
  const lines = Array.from({ length: 12000 }, () => 'x;');
  const steps = methodSteps({ node: { path: 'tall.js', qualified_name: 'tall', line: 1, end_line: lines.length }, lines });
  expect(steps.at(-1).covers.end_line).toBe(lines.length);
  for (const step of steps) expect(estimateTokens(step.state)).toBeLessThanOrEqual(STATE_BUDGET);
});

// These are independent content controls: equal-length text need not consume equal token counts.
it('estimates token density rather than making file length the request budget', () => {
  const word = 'internationalization '.repeat(1800);
  const symbols = 'a!'.repeat(word.length / 2);
  expect(textTokens(symbols)).toBeGreaterThan(textTokens(word) * 2);
  expect(() => questionBatches({ source: word }, { q: { type: 'noul' } })).not.toThrow();
  expect(() => questionBatches({ source: symbols }, { q: { type: 'noul' } })).toThrow(/token budget/);
});

it('counts Unicode, escaped strings, and literal special-token spellings as text', () => {
  const state = { source: '日本語 😀 " \\ <|endoftext|>'.repeat(2000) };
  expect(estimateTokens(state)).toBeGreaterThanOrEqual(tokens(state));
  const chunks = sourceChunks(state.source, { path: 'unicode.txt', maxTokens: 1000 });
  for (const chunk of chunks) {
    expect(chunk.source).not.toContain('�');
    expect(tokens(chunk.source)).toBeLessThan(TOKEN_LIMITS.single);
  }
});

describe('a method whose neighbourhood does not fit', () => {
  const neighbour = (name, size) => ({ node: { id: `n.js::${name}`, path: 'n.js', qualified_name: name, line: 1, end_line: size }, lines: Array.from({ length: size }, (_, i) => `  const ${name}_${i} = compute(${i}, "${'x'.repeat(60)}");`), site: 1, calls: [] });
  const node = { id: 'a.js::small', path: 'a.js', qualified_name: 'small', line: 1, end_line: 3 };
  const lines = ['function small(x) {', '  return x + 1;', '}'];
  const callees = Array.from({ length: 8 }, (_, i) => neighbour(`callee${i}`, 400));
  const callers = Array.from({ length: 8 }, (_, i) => neighbour(`caller${i}`, 400));
  const edges = [...callees, ...callers].map(item => `${item.node.qualified_name} -> small`);

  it('shows fewer neighbours before refusing, and reads the method alone when none fit', () => {
    // At this budget the sixteen 3-line excerpts plus their names and edges do not fit; shortening alone threw here on every retry.
    const step = methodStep({ node, lines, callees, callers, edges, budget: 1400 });
    const shown = step.calls.length + step.calledBy.length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(16);
    expect(step.state.method.source).toContain('return x + 1');
    // Room for the method and nothing else: the smallest neighbour excerpt is more than the margin.
    const bare = estimateTokens(methodStep({ node, lines, callees: [], callers: [], edges: [] }).state);
    const alone = methodStep({ node, lines, callees, callers, edges, budget: bare + 20 });
    expect(alone.calls).toEqual([]);
    expect(alone.calledBy).toEqual([]);
    expect(alone.state.call_graph).toEqual([]);
    expect(alone.state.method.source).toContain('return x + 1');
    expect(Object.keys(alone.questions).some(name => name.startsWith('misuse'))).toBe(false);
  });

  it('still refuses when the method itself does not fit', () => {
    expect(() => methodStep({ node, lines, callees, callers, edges, budget: 40 })).toThrow('exceeds the token budget');
  });
});
