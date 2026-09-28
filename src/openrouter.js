/**
 * The System One questions asked of a chat model through OpenRouter, or any endpoint that speaks its chat completions format.
 *
 * A chat model answers in text, not in probabilities, so each question is put to it with a JSON schema that leaves room for
 * nothing but a probability per answer, and the reply is read back into the answers System One would have given. The numbers are
 * the model's own estimates rather than a calibrated distribution, so a floor tuned against Jev may want moving.
 */
import { createSystemOne } from './systemone.js';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-6-luna';

const INSTRUCTIONS = `You answer typed questions about the code in STATE. Answer each question on its own, from STATE alone. A name in
backticks is a field of STATE or of the question's instructions; a name found in neither, such as \`rule\`, is the statement in
criteria.true.

- noul: two statements, a and b, and one of them describes the code. A probability for each. They sum to 1. The instructions say
  what the statements are about; judge the statements, not the wording of the instructions.
- choice: a probability for every option in criteria. They sum to 1.
- score: a probability for every level in criteria, keyed by its index, weakest first. They sum to 1.

Each answer starts with why: one short sentence on what the code does about this question. The numbers follow from it.

Be calibrated. 0.5 means the code does not tell you. Go near 0 or 1 only when the code shows it.`;

/**
 * What each answer is a probability of, keyed as the answer names it. A score's levels are a list and are keyed by index. A noul's
 * two criteria become two statements to choose between, since a noul with none is still a yes or a no.
 */
function levels(question) {
  if (question.type === 'score') return Object.fromEntries(question.criteria.map((level, index) => [String(index), level]));
  if (question.type === 'noul') return { a: question.criteria?.true ?? 'Yes', b: question.criteria?.false ?? 'No' };
  return question.criteria;
}
const options = question => Object.keys(levels(question) ?? {});

/**
 * Every answer starts with a sentence saying what the code does about the question, and a noul picks between its two statements.
 * Asked how likely criteria.true was, or to answer `Is \`rule\` true of the code below?` yes or no, a model described an ensure
 * rule's breach correctly every time and still called the rule true in half the scans: the rule's own text describes the breach,
 * and that description is true of the code.
 */
const closed = keys => ({ type: 'object', additionalProperties: false, required: ['why', ...keys],
  properties: { why: { type: 'string' }, ...Object.fromEntries(keys.map(key => [key, { type: 'number' }])) } });
const schemaOf = question => closed(options(question));

/** A model's numbers, held to what a distribution is: nothing below 0, and a total of 1. One that says nothing says nothing either way. */
function distribution(keys, raw) {
  const kept = keys.map(key => [key, Math.max(0, Number(raw?.[key]) || 0)]);
  const total = kept.reduce((sum, [, p]) => sum + p, 0);
  return Object.fromEntries(kept.map(([key, p]) => [key, total ? p / total : 1 / keys.length]));
}

function answerOf(question, raw) {
  if (question.type === 'noul') return { type: 'noul', noul: distribution(['a', 'b'], raw).a };
  const probabilities = distribution(options(question), raw);
  const [choice, confidence] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
  return question.type === 'choice'
    ? { type: 'choice', choice, confidence, probabilities }
    : { type: 'score', score: Number(choice), confidence, probabilities };
}

/** Some models fence their JSON even when asked for a schema. */
const parse = text => JSON.parse(String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));

export const OPENROUTER_WIRE = {
  name: 'OpenRouter',
  body: (model, state, questions) => ({
    model,
    messages: [
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: JSON.stringify({ state, questions: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, { ...question, criteria: levels(question) }])) }) },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'answers', strict: true,
      schema: { type: 'object', additionalProperties: false, required: Object.keys(questions),
        properties: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, schemaOf(question)])) } } },
    // Unset, OpenRouter holds back credit for the model's whole output limit on every request, and refuses a key running low.
    max_tokens: 16384,
    // A provider that would ignore the schema answers in prose, and prose has no probabilities in it.
    provider: { require_parameters: true },
    usage: { include: true },
  }),
  read(response, questions) {
    if (response.error) throw new Error(`OpenRouter request failed: ${response.error.message ?? JSON.stringify(response.error)}`);
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error(`OpenRouter returned no answer (finish reason ${response.choices?.[0]?.finish_reason ?? 'unknown'})`);
    const raw = parse(content);
    const answers = {};
    for (const [id, question] of Object.entries(questions)) if (raw[id]) answers[id] = answerOf(question, raw[id]);
    const usage = response.usage;
    return { model: response.model, answers,
      usage: usage ? { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, ...(typeof usage.cost === 'number' ? { cost: usage.cost } : {}) } : null };
  },
};

export const createOpenRouter = ({ model, baseUrl, ...options }) =>
  createSystemOne({ ...options, model: model || DEFAULT_OPENROUTER_MODEL, baseUrl: baseUrl || OPENROUTER_URL, wire: OPENROUTER_WIRE });
