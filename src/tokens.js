/** Request sizes are token estimates. Jev does not publish its tokenizer. */
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';

/** Perch Cloud's bug model takes at most 128 options in one Choice; a longer list is narrowed through windows first. */
export const MAX_CHOICES = 128;

// Leave room below Jev's 32k per question and 64k per request limits for server formatting.
export const TOKEN_LIMITS = Object.freeze({ state: 24000, single: 30000, request: 60000 });
const literal = { disallowedSpecial: new Set() };

/** o200k plus 20% headroom is an estimate, not Jev's exact tokenization. */
export function textTokens(text) {
  let count = 0;
  // Bounded tokenizer inputs avoid quadratic BPE work on enormous single words or literals.
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 4096);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    count += countTokens(text.slice(start, end), literal);
    start = end;
  }
  return Math.ceil(count * 1.2);
}
export const estimateTokens = value => textTokens(JSON.stringify(value));
export class IncompleteCheckError extends Error {
  constructor(message) { super(`Check incomplete: ${message}`); this.name = 'IncompleteCheckError'; }
}
/** Only size failures trigger repacking; authentication and other validation errors propagate. */
export class ContextLimitError extends IncompleteCheckError {
  constructor(message, budget) { super(message); this.name = 'ContextLimitError'; this.budget = budget; }
}
/**
 * Rebuild a reading at half the token budget each time the endpoint says it is too large. A reading is otherwise sent in as many
 * requests as it takes; this is the one loop that has to end, so it gives up after eight halvings or below 128 tokens.
 */
export async function withTokenRetries(read, initial = TOKEN_LIMITS.state) {
  let budget = initial;
  for (let attempt = 0; ; attempt++) {
    try { return await read(budget); }
    catch (error) {
      if (!(error instanceof ContextLimitError)) throw error;
      const smaller = Math.floor(Math.min(budget / 2, error.budget ?? Infinity));
      if (attempt >= 8 || smaller < 128) throw new IncompleteCheckError(`cannot fit the code and question after reducing the token budget: ${error.message}`);
      budget = smaller;
    }
  }
}
/**
 * Count state once, include every question and criterion, and preserve each question intact. A batch closes when the next
 * question would not fit the request.
 */
export function questionBatches(state, questions, limits = TOKEN_LIMITS) {
  const size = estimateTokens(state);
  if (size > limits.state) throw new ContextLimitError('request state exceeds its estimated token budget', Math.floor(limits.state / 2));
  const batches = [];
  let current = {}, total = size + 64;
  for (const [name, question] of Object.entries(questions)) {
    const tokens = estimateTokens({ [name]: question }) + 32;
    if (size + tokens + 64 > limits.single)
      throw new ContextLimitError(`question ${name} and its context exceed the estimated token budget`, Math.floor(size / 2));
    if (question.criteria && Object.keys(question.criteria).length > MAX_CHOICES)
      throw new IncompleteCheckError(`question ${name} has more than ${MAX_CHOICES} choices`);
    if (total + tokens > limits.request && Object.keys(current).length) { batches.push(current); current = {}; total = size + 64; }
    if (total + tokens > limits.request) throw new ContextLimitError(`question ${name} exceeds the request token budget`, Math.floor(size / 2));
    current[name] = question;
    total += tokens;
  }
  if (Object.keys(current).length || !batches.length) batches.push(current);
  return batches;
}
