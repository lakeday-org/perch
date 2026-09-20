import { expect, it } from 'vitest';
import { lineId, lineWindows, locateWhere, whereWindowQuestion } from '../src/questions.js';

it.each([255, 256, 65025, 65026, 150195])('keeps all %i candidate lines reachable with at most 255 windows', count => {
  // Gaps represent blank/comment lines that were removed before localization.
  const ids = Array.from({ length: count }, (_, index) => lineId(17 + index * 3));
  const windows = lineWindows(ids);
  if (count <= 255) { expect(windows).toBeNull(); return; }
  expect(windows.length).toBeLessThanOrEqual(255);
  expect(windows.flat()).toEqual(ids);
  expect(Object.keys(whereWindowQuestion(windows).criteria).length).toBeLessThanOrEqual(255);
});

it.each([1, 75098, 150195])('can locate line %i among 150,195 candidates without an oversized choice', async target => {
  const ids = Array.from({ length: 150195 }, (_, index) => lineId(index + 1));
  const windows = lineWindows(ids);
  const requests = [];
  const systemOne = { async ask(_state, questions) {
    requests.push(questions);
    const answers = {};
    for (const [name, question] of Object.entries(questions)) {
      if (name === 'has_bug') { answers[name] = { noul: 0.9 }; continue; }
      expect(Object.keys(question.criteria).length).toBeLessThanOrEqual(255);
      if (name === 'where_window') {
        const match = Object.entries(question.criteria).find(([, span]) => {
          const [start, end] = span.match(/\d+/g).map(Number);
          return start <= target && target <= end;
        });
        expect(match).toBeDefined();
        answers[name] = { choice: match[0] };
      } else {
        expect(question.criteria).toHaveProperty(lineId(target));
        answers[name] = { choice: lineId(target), confidence: 0.9 };
      }
    }
    return { model: 'fixture', answers, usage: { input_tokens: 10, output_tokens: 0 } };
  } };
  const result = await locateWhere({ systemOne, state: {}, windows,
    questions: { has_bug: { type: 'noul', instructions: 'Is there a bug?' }, where_window: whereWindowQuestion(windows) } });
  expect(requests).toHaveLength(3);
  expect(result.answers.where.choice).toBe(lineId(target));
  expect(result.answers.has_bug.noul).toBe(0.9);
  expect(result.usage.input_tokens).toBe(30);
});
