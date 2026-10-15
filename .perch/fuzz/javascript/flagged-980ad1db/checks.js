import assert from 'node:assert/strict';
import { issuesOf, isDesign } from './src/questions.js';
import { questionSet } from './src/ask.js';
function answersForCheck(v) {
  const questions = questionSet();
  const answers = {};
  for (const slot of v.answers) {
    if (questions.length) answers[questions[slot.index % questions.length].name] = slot.answer;
  }
  if (v.lint !== null) {
    const question = questions.length ? questions[v.lint.rule % questions.length] : null;
    answers.lint = { rule: question ? question.name : String(v.lint.rule), broken: v.lint.broken };
  }
  if (v.closed !== null) answers.closed = v.closed;
  return answers;
}
/** flagged agrees with whether issuesOf finds any non-design issue. */
export function check_issues_of_agrees(v, result) {
  const min = v.case === "flagged_default" ? 0 : v.min;
  const expected = issuesOf(answersForCheck(v), min).some(issue => !isDesign(issue));
  assert.strictEqual(result, expected, `flagged returned ${result}; issuesOf-derived result was ${expected} for ${JSON.stringify(v)}`);
}
/** Raising the minimum threshold cannot introduce a non-design finding. */
export function check_threshold_monotonic(v, result) {
  const atZero = issuesOf(answersForCheck(v), 0).some(issue => !isDesign(issue));
  assert(!result || atZero, `result at the supplied threshold was ${result}, but result at threshold 0 was ${atZero} for ${JSON.stringify(v)}`);
}