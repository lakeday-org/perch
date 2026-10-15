import { parseQuestions } from './src/ask.js';
import { check } from './src/ask.js';
export async function fuzz(v) {
  return parseQuestions(v.text, v.at, v.noun);
}