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
backticks is a field of STATE or of the question's instructions.

- noul: p is the probability that criteria.true holds rather than criteria.false.
- choice: a probability for every option in criteria. They sum to 1.
- score: a probability for every level in criteria, keyed by its index, weakest first. They sum to 1.

Be calibrated. 0.5 means the code does not tell you. Go near 0 or 1 only when the code shows it.`;

/** A score's levels are a list; keyed by index they are asked for the same way a choice's options are. */
const levels = question => (question.type === 'score' ? Object.fromEntries(question.criteria.map((level, index) => [String(index), level])) : question.criteria);
const options = question => Object.keys(levels(question) ?? {});

const number = { type: 'number' };
const closed = keys => ({ type: 'object', additionalProperties: false, required: keys, properties: Object.fromEntries(keys.map(key => [key, number])) });
const schemaOf = question => (question.type === 'noul' ? closed(['p']) : closed(options(question)));

/** A model's numbers, held to what a distribution is: nothing below 0, and a total of 1. One that says nothing says nothing either way. */
function distribution(keys, raw) {
  const kept = keys.map(key => [key, Math.max(0, Number(raw?.[key]) || 0)]);
  const total = kept.reduce((sum, [, p]) => sum + p, 0);
  return Object.fromEntries(kept.map(([key, p]) => [key, total ? p / total : 1 / keys.length]));
}

function answerOf(question, raw) {
  if (question.type === 'noul') return { type: 'noul', noul: Math.min(1, Math.max(0, Number(raw.p) || 0)) };
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
