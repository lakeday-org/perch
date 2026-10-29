/** Request sizes are token estimates. Jev does not publish its tokenizer. */

/** Perch Cloud's bug model takes at most 128 options in one Choice; a longer list is narrowed through windows first. */
export const MAX_CHOICES = 128;

/**
 * The three budgets one context length gives: the whole request, a method's code and neighbourhood at 80% of it, and that plus
 * one question at 96%, the rest being room for server formatting.
 */
export const contextLimits = length => Object.freeze({ state: Math.floor(length * 0.8), single: Math.floor(length * 0.96), request: length });
/** Jev 1.14 takes 32k tokens a question and 64k a request (docs.typesafe.ai/models); room is left below both for server formatting. */
export const JEV_TOKENS = Object.freeze({ state: 24000, single: 30000, request: 60000 });
/**
 * OpenAI's Decisions API takes 922k input tokens but prices a request past 272k at twice the rate, so that is its ceiling here.
 * Perch Cloud's perch-latest takes the same. Jev with long context on takes 262k for both limits, so the same numbers serve it;
 * TypeSafe says that is slower and less accurate, so it is only ever chosen (PERCH_CONTEXT_LENGTH), never assumed.
 */
export const DECISIONS_TOKENS = contextLimits(250000);
/** Each model's token limits, by the start of its id. A model named here gets its own; any other gets Jev's. */
export const MODEL_TOKEN_LIMITS = Object.freeze({ jev: JEV_TOKENS, 'gpt-6-luna': DECISIONS_TOKENS, perch: DECISIONS_TOKENS });
export function tokenLimitsFor(model) {
  const id = String(model ?? '').toLowerCase();
  const prefix = Object.keys(MODEL_TOKEN_LIMITS).filter(start => id.startsWith(start)).sort((a, b) => b.length - a.length)[0];
  return prefix ? MODEL_TOKEN_LIMITS[prefix] : JEV_TOKENS;
}
/**
 * The limits a client starts from: Jev's tokens, and any number of questions that fit; another model may take fewer, and says
 * so in `_meta.max_questions`, which `createSystemOne` puts in `questions`. A client sizes its tokens by model (tokenLimitsFor).
 */
export const TOKEN_LIMITS = Object.freeze({ ...JEV_TOKENS, questions: Infinity, options: MAX_CHOICES });
/**
 * Bytes counted as one token. An estimate from a request's length costs nothing to make, where counting it with a tokenizer was
 * most of a scan's CPU. Three bytes a token is about what the o200k tokenizer plus 20% headroom gave the largest method readings,
 * the ones that reach the budget. An endpoint that still finds a request too big says so, and the reading is rebuilt smaller
 * (withTokenRetries).
 */
export const BYTES_PER_TOKEN = 3;
export const textTokens = text => Math.ceil(Buffer.byteLength(text) / BYTES_PER_TOKEN);
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
 * question would not fit the request, or when it holds as many questions as the model takes.
 */
export function questionBatches(state, questions, limits = TOKEN_LIMITS) {
  const size = estimateTokens(state);
  const most = limits.questions ?? Infinity, options = limits.options ?? MAX_CHOICES;
  if (size > limits.state) throw new ContextLimitError('request state exceeds its estimated token budget', Math.floor(limits.state / 2));
  const batches = [];
  let current = {}, total = size + 64;
  for (const [name, question] of Object.entries(questions)) {
    const tokens = estimateTokens({ [name]: question }) + 32;
    if (size + tokens + 64 > limits.single)
      throw new ContextLimitError(`question ${name} and its context exceed the estimated token budget`, Math.floor(size / 2));
    if (question.criteria && Object.keys(question.criteria).length > options)
      throw new IncompleteCheckError(`question ${name} has more than ${options} choices`);
    const held = Object.keys(current).length;
    if ((total + tokens > limits.request || held >= most) && held) { batches.push(current); current = {}; total = size + 64; }
    if (total + tokens > limits.request) throw new ContextLimitError(`question ${name} exceeds the request token budget`, Math.floor(size / 2));
    current[name] = question;
    total += tokens;
  }
  if (Object.keys(current).length || !batches.length) batches.push(current);
  return batches;
}
