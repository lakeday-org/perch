import { describe, expect, it } from 'vitest';
import { parseQuestions } from '../src/ask.js';
import { askUnitSteps, readLint, unitSteps } from '../src/units.js';
import { TOKEN_LIMITS, estimateTokens } from '../src/tokens.js';

const rules = parseQuestions(`
- name: explains
  where: docs/*.md
  ensure: The document explains the behavior.
- name: receipt
  where: docs/*.md
  ensure_present: a verified receipt
- name: secret
  where: docs/*.md
  ensure_absent: a private key
`, 'perch.yaml', 'rule');
const unit = { id: 'docs/big.md', path: 'docs/big.md', name: 'docs/big.md', line: 1, part: false };

/** A file long enough to take several pieces at this budget. */
const body = 'Documented behavior.\n'.repeat(3000);

describe('a file rule over a file read in pieces', () => {
  it('answers from the pieces: the lowest for ensure, the likeliest piece for a search, and is not incomplete', async () => {
    const budget = 2000;
    const prepare = b => unitSteps({ rules, unit, source: body, budget: b });
    const steps = prepare(budget);
    expect(steps.length).toBeGreaterThan(2);
    // Each piece answers differently, so which one the file takes is visible.
    let n = 0;
    const scores = [];
    const systemOne = { limits: { state: budget }, async ask(state, questions) {
      const i = n++;
      const piece = { explains: [0.9, 0.2, 0.8][i % 3], receipt: [0.05, 0.7, 0.1][i % 3], secret: [0.01, 0.02, 0.6][i % 3] };
      scores.push(piece);
      return { answers: Object.fromEntries(Object.keys(questions).map(name => [name, { noul: piece[name] }])) };
    } };
    const result = await askUnitSteps({ systemOne, steps, prepare, rules });
    expect(result).not.toHaveProperty('incomplete');
    expect(readLint(rules[0], result.answers).broken).toBeCloseTo(1 - Math.min(...scores.map(s => s.explains)));
    expect(readLint(rules[1], result.answers).here).toBeCloseTo(Math.max(...scores.map(s => s.receipt)));
    expect(readLint(rules[2], result.answers).broken).toBeCloseTo(Math.max(...scores.map(s => s.secret)));
    // The evidence is the piece that decided it.
    expect(result.evidence.explains.startByte).toBe(steps[scores.findIndex(s => s.explains === 0.2)].chunk.startByte);
  });

  it('cuts a sees:file companion to fit, so the unit itself still gets read', () => {
    const method = { id: 'src/a.js::f', path: 'src/a.js', name: 'f', line: 1, part: true };
    const companion = 'const line = "much the same";\n'.repeat(20000);
    const steps = unitSteps({ rules: rules.slice(0, 1), unit: method, source: 'function f() { return 1; }', seen: { file_source: companion } });
    expect(steps).toHaveLength(1);
    expect(estimateTokens(steps[0].state)).toBeLessThanOrEqual(TOKEN_LIMITS.state);
    expect(steps[0].state.file_source).toContain('cut to fit');
    expect(steps[0].state.file_source.length).toBeLessThan(companion.length);
    // A companion that fits is shown whole.
    const small = unitSteps({ rules: rules.slice(0, 1), unit: method, source: 'function f() { return 1; }', seen: { file_source: 'const x = 1;\n' } });
    expect(small[0].state.file_source).toBe('const x = 1;\n');
  });
});
