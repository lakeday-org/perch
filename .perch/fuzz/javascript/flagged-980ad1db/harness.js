import { flagged } from './src/questions.js';
import { questionSet } from './src/ask.js';
function buildAnswers(v) {
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
export async function fuzz(v) {
  const answers = buildAnswers(v);
  return v.case === "flagged_default" ? flagged(answers) : flagged(answers, v.min);
}