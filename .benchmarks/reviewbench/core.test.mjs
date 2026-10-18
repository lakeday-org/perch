import { describe, expect, it } from 'vitest';
import { decisionPayload, normalize, metric, flagsOf } from './core.mjs';

const q = { bug: { type: 'noul', instructions: 'Does target contain a bug?', criteria: { true: 'A valid input fails.', false: 'Valid inputs work.' } } };
describe('ReviewBench decision protocol', () => {
  it('sends exactly two options and reads true by value rather than position', () => {
    const request = decisionPayload({ source: 'code' }, q);
    expect(request.questions[0].instructions).toBe(q.bug.instructions);
    expect(request.questions[0].choices.map(c => c.value)).toEqual(['true', 'false']);
    expect(normalize({ answers: [{ name: 'bug', type: 'choice', probabilities: [{ value: 'false', probability: .1 }, { value: 'true', probability: .9 }] }] }, q).bug.noul).toBe(.9);
  });
  it('refuses a question without both criteria rather than sending it some other way', () => {
    const half = { bug: { type: 'noul', instructions: 'Does target contain a bug?', criteria: { true: 'A valid input fails.' } } };
    expect(() => decisionPayload({ source: 'code' }, half)).toThrow('Unsupported question shape');
  });
  it('preserves refusals and rejects malformed distributions', () => {
    expect(() => normalize({ answers: [{ name: 'bug', type: 'refusal' }] }, q)).toThrow('Refusal');
    expect(() => normalize({ answers: [{ name: 'bug', type: 'choice', probabilities: [{ value: 'true', probability: .9 }, { value: 'false', probability: .9 }] }] }, q)).toThrow('Invalid distribution');
  });
  it('counts a failed positive as a miss and a failed clean target as a false alert', () => {
    const score = metric([{ id: 'positive', labels: [1] }, { id: 'clean', labels: [] }], new Set(['positive']), new Set(['positive', 'clean']));
    expect([score.tp, score.fp, score.fn, score.tn]).toEqual([0, 1, 1, 0]);
  });
  it('does not count an exact-floor probability as a detection', () => {
    expect(flagsOf({ id: 'a', arm: 'change_current', answers: { change_bug: { type: 'noul', noul: .6 }, change_security: { type: 'noul', noul: .7 } } })).toEqual([]);
  });
});
