/** Request sizes are token estimates. Jev does not publish its tokenizer. */
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';

// Leave room below Jev's 32k per question and 64k per request limits for server formatting. The gateway takes at most 128
// questions in one request.
export const TOKEN_LIMITS = Object.freeze({ state: 24000, single: 30000, request: 60000, unitRequests: 64, questions: 128 });
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
/** How many requests a reading takes: one per question batch of each pass, and one more for a pass that then locates a line. */
export function requestsFor(steps, limits = TOKEN_LIMITS) {
  return steps.reduce((total, step) => total + questionBatches(step.state, step.questions, limits).length + (step.windows ? 1 : 0), 0);
}

const scoped = Symbol('unit request allowance');
/**
 * Share a finite allowance across chunks, question batches, localization and retries for one reading.
 *
 * A reading that needs more than the allowance is refused before its first request. The count is known from the passes and
 * their batches, and finding out by sending meant a 1.5 MB function had 64 requests accepted and paid for, then thrown away.
 */
export function requestScope(systemOne) {
  if (systemOne[scoped]) return systemOne;
  const maximum = systemOne.limits?.unitRequests ?? TOKEN_LIMITS.unitRequests;
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('unit request allowance must be a positive integer');
  let requests = 0;
  const reserve = () => {
    if (requests >= maximum) throw new IncompleteCheckError(`unit request allowance exhausted (${maximum} attempts)`);
    requests++;
  };
  const fits = steps => {
    const needed = requestsFor(steps, { ...TOKEN_LIMITS, ...systemOne.limits });
    if (requests + needed > maximum) throw new IncompleteCheckError(`the reading needs ${needed} requests and the allowance for one unit is ${maximum}, so none were sent`);
  };
  return { ...systemOne, [scoped]: true, allowance: maximum, fits, ask(state, questions) {
    reserve();
    let first = true;
    return systemOne.ask(state, questions, { beforeRequest() { if (first) first = false; else reserve(); } });
  } };
}
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
 * question would not fit the request, or when it holds as many questions as the gateway accepts: 129 small ones fit the tokens
 * and were still refused.
 */
export function questionBatches(state, questions, limits = TOKEN_LIMITS) {
  const most = limits.questions ?? TOKEN_LIMITS.questions;
  const size = estimateTokens(state);
  if (size > limits.state) throw new ContextLimitError('request state exceeds its estimated token budget', Math.floor(limits.state / 2));
  const batches = [];
  let current = {}, total = size + 64;
  for (const [name, question] of Object.entries(questions)) {
    const tokens = estimateTokens({ [name]: question }) + 32;
    if (size + tokens + 64 > limits.single)
      throw new ContextLimitError(`question ${name} and its context exceed the estimated token budget`, Math.floor(size / 2));
    if (question.criteria && Object.keys(question.criteria).length > 255)
      throw new IncompleteCheckError(`question ${name} has more than 255 choices`);
    const held = Object.keys(current).length;
    if ((total + tokens > limits.request || held >= most) && held) { batches.push(current); current = {}; total = size + 64; }
    if (total + tokens > limits.request) throw new ContextLimitError(`question ${name} exceeds the request token budget`, Math.floor(size / 2));
    current[name] = question;
    total += tokens;
  }
  if (Object.keys(current).length || !batches.length) batches.push(current);
  return batches;
}
