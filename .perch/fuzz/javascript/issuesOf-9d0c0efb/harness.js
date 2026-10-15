import { issuesOf } from './src/questions.js';
export async function fuzz(v) {
  return issuesOf(v.answers, v.min, v.questions);
}