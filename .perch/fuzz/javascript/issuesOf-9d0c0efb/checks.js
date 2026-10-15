import assert from 'node:assert/strict';
import { issuesOf, label } from './src/questions.js';
import { issues } from './src/ask.js';

/** Returned findings are ordered by descending probability. */
export function check_probability_order(v, result) {
  for (let i = 1; i < result.length; i++) {
    assert(result[i - 1].probability >= result[i].probability, `input=${JSON.stringify(v)} result=${JSON.stringify(result)} has an out-of-order pair`);
  }
}

/** The public result agrees with the underlying issue computation when no lint or closed findings are involved. */
export function check_underlying_issues_agree(v, result) {
  if (v.questions === undefined || v.answers.lint !== undefined || v.answers.closed !== undefined) return;
  const expected = issues(v.answers, v.min, v.questions, label);
  assert.deepStrictEqual(result, expected, `input=${JSON.stringify(v)} public result=${JSON.stringify(result)} underlying result=${JSON.stringify(expected)}`);
}

/** Closing labels removes those findings without changing the other findings. */
export function check_closed_labels(v, result) {
  if (v.questions === undefined) return;
  const answers = { ...v.answers };
  delete answers.closed;
  const allIssues = issuesOf(answers, v.min, v.questions);
  const closed = new Set(v.answers.closed?.kinds ?? []);
  const expected = allIssues.filter(issue => !closed.has(issue.label));
  assert.deepStrictEqual(result, expected, `input=${JSON.stringify(v)} result=${JSON.stringify(result)} after-closing result=${JSON.stringify(expected)}`);
}

/** Adding an answer no question reads does not change the findings. */
export function check_irrelevant_answer(v, result) {
  if (v.questions === undefined) return;
  const key = "__fuzz_irrelevant_answer__";
  if (v.questions.some(question => question.name === key) || v.answers.lint !== undefined || v.answers.closed !== undefined) return;
  const changed = { ...v.answers, [key]: 0.37 };
  const expected = issuesOf(changed, v.min, v.questions);
  assert.deepStrictEqual(result, expected, `input=${JSON.stringify(v)} result=${JSON.stringify(result)} with-irrelevant-answer=${JSON.stringify(expected)}`);
}

/** At a zero run floor, changing question-specific floors cannot change the findings. */
export function check_zero_floor_ignores_question_min(v, result) {
  if (v.questions === undefined || v.min !== 0 || v.answers.lint !== undefined) return;
  const changedQuestions = v.questions.map(question => ({ ...question, min: question.min === 100 ? 0 : 100 }));
  const expected = issuesOf(v.answers, 0, changedQuestions);
  assert.deepStrictEqual(result, expected, `input=${JSON.stringify(v)} result=${JSON.stringify(result)} with-changed-question-floors=${JSON.stringify(expected)}`);
}