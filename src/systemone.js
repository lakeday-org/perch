/** TypeSafe System One client: typed questions over a state, answered with probabilities. */
import { questionBatches, estimateTokens, TOKEN_LIMITS, ContextLimitError } from './tokens.js';

export const DEFAULT_SYSTEM_ONE_MODEL = 'jev-latest';
export const DECISIONS_MODEL = 'gpt-6-luna';

/** Credentials apply to the whole run, so trying another file cannot repair their rejection. */
export class AuthenticationError extends Error {
  constructor(status, detail = '', service = 'System One') {
    super(`${service} request failed with HTTP ${status}: ${String(detail).slice(0, 500)}`);
    this.name = 'AuthenticationError'; this.status = status; this.detail = detail;
  }
}

/** A URL whose path ends in /decisions is OpenAI's Decisions API, which asks the same questions in its own format. */
export const speaksDecisions = url => /\/decisions\/?(?:[?#]|$)/.test(String(url ?? ''));

/** The variable holding the key for PERCH_BASE_URL: PERCH_API_KEY, else the one its provider documents. */
export const endpointKey = env => (env.PERCH_API_KEY ? 'PERCH_API_KEY' : speaksDecisions(env.PERCH_BASE_URL) ? 'OPENAI_API_KEY' : 'TYPESAFE_API_KEY');

/** System One's format is perch's own, so it goes out and comes back as it is. */
const SYSTEM_ONE = { service: 'System One', model: DEFAULT_SYSTEM_ONE_MODEL, body: request => request, reply: answer => answer };

/**
 * System One binds a role named in an instruction to a graph node by its id. A Decisions instruction is one string, so it says
 * which node each role is.
 */
const spelled = instructions => (instructions == null || typeof instructions === 'string' ? instructions ?? ''
  : [...Object.entries(instructions).filter(([key]) => key !== 'question').map(([role, id]) => `\`${role}\` is ${id} in graph.nodes.`), instructions.question].join(' '));

/** The option a Decisions choice falls back to. Asked a choice none of whose options fits, the API refuses it; System One never does. */
const NONE = 'none_of_these';

/**
 * OpenAI's Decisions API. The state goes as one string and the questions as an array naming each one, and the answers come back
 * the same way. It takes 200 questions a request and does not say so in its answers.
 *
 * A noul with criteria is asked as a choice between them, which is how System One reads one. Asked as predicates, with the
 * criteria written into the instructions, gpt-6-luna refused 18 of 612 in one file's scan, and a refusal costs the whole reading. A
 * choice is given a fallback, which its answer leaves out, so what comes back is spread over the options asked about as a System
 * One answer is. An option needs a description, so one without is described by its own name. A score level is labelled by its
 * index, which is what its probabilities come back keyed by.
 */
const DECISIONS = {
  service: 'Decisions API',
  model: DECISIONS_MODEL,
  limits: { max_questions: 200 },
  body: ({ model, state, questions }) => ({
    model,
    input: typeof state === 'string' ? state : JSON.stringify(state),
    questions: Object.entries(questions).map(([name, { type, instructions, criteria }]) => {
      const text = spelled(instructions);
      if (type === 'score') return { type, name, instructions: text, levels: criteria.map((description, index) => ({ label: String(index), description })) };
      if (type !== 'choice' && !criteria) return { type: 'predicate', name, instructions: text };
      const options = type === 'choice' ? criteria : { true: criteria.true, false: criteria.false };
      const choices = Object.entries(options).map(([value, description]) => ({ value, description: description ?? value }));
      return { type: 'choice', name, instructions: text, choices: type === 'choice' && !(NONE in options) ? [...choices, { value: NONE, description: 'None of these fits' }] : choices };
    }),
  }),
  reply: ({ answers = [], ...rest }, { questions }) => {
    const refused = answers.filter(answer => answer.type === 'refusal').map(answer => answer.name);
    if (refused.length) throw new Error(`${rest.model ?? DECISIONS_MODEL} declined to answer ${refused.join(', ')}`);
    return { ...rest, answers: Object.fromEntries(answers.map(({ name, type, probability, probabilities, ...answer }) => {
      const asked = questions[name], shares = Object.fromEntries((probabilities ?? []).map(option => [option.value, option.probability]));
      if (asked?.type === 'noul') return [name, { type: 'noul', noul: type === 'predicate' ? probability : shares.true ?? 0 }];
      if (asked?.type !== 'choice' || NONE in asked.criteria) return [name, { type, ...answer, probabilities: shares }];
      delete shares[NONE];
      const options = Object.keys(shares), total = options.reduce((sum, option) => sum + shares[option], 0);
      const spread = Object.fromEntries(options.map(option => [option, total > 0 ? shares[option] / total : 1 / options.length]));
      const choice = answer.choice in spread ? answer.choice : options.reduce((best, option) => (spread[option] > spread[best] ? option : best));
      return [name, { type, ...answer, choice, probabilities: spread }];
    })) };
  },
};

export function createSystemOne({
  apiKey,
  model,
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.typesafe.ai/v1/systemone',
  retryDelayMs = 2000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = () => {},
  limits = TOKEN_LIMITS,
  firstQuestions = Infinity,
} = {}) {
  if (!apiKey) throw new Error('PERCH_API_KEY is not set. Export an API key before running perch scan or perch check.');
  const wire = speaksDecisions(baseUrl) ? DECISIONS : SYSTEM_ONE, { service } = wire;
  model ??= wire.model;
  // A copy, so what this endpoint reports about itself changes this client and no other.
  limits = { ...TOKEN_LIMITS, ...limits };
  let authenticationFailure = null, answered = false, opening = null;

  /**
   * How many questions and options the model takes, as it reports them in `_meta`. Beam's models take 32 questions a request
   * where Jev takes any number that fit; a model that says nothing keeps the limits it was given. A report only lowers them,
   * so a smaller limit set on purpose stands.
   */
  function learn(meta) {
    const most = [meta?.max_questions, meta?.max_batch_questions].filter(value => Number.isSafeInteger(value) && value > 0);
    if (most.length) limits.questions = Math.min(limits.questions, ...most);
    if (Number.isSafeInteger(meta?.max_options) && meta.max_options > 1) limits.options = Math.min(limits.options, meta.max_options);
  }
  learn(wire.limits);

  async function request(body, attempted, beforeRequest) {
    for (let attempt = 0; ; attempt++) {
      if (authenticationFailure) throw new AuthenticationError(authenticationFailure.status, authenticationFailure.detail, service);
      beforeRequest();
      let response;
      try {
        attempted();
        response = await fetchImpl(baseUrl, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(wire.body(body)) });
      } catch (error) {
        if (attempt >= 3) throw error;
        log(`${service} request failed (${error.message}); retrying`);
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        // OpenAI says an account is out of credit with a 429, which no wait changes, so it stops the run the way a 402 does.
        const detail = response.status === 429 ? (await response.text().catch(() => '')).slice(0, 2000) : '';
        if (/\binsufficient_quota\b/.test(detail)) {
          authenticationFailure = new AuthenticationError(response.status, detail, service);
          throw authenticationFailure;
        }
        if (attempt >= 3) throw new Error(`${service} request failed with HTTP ${response.status} after four attempts`);
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        log(`${service} returned HTTP ${response.status}; retrying`);
        await sleep(retryAfter > 0 ? retryAfter * 1000 : retryDelayMs * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 2000);
        // 402 is the account out of credits. Every request will get the same answer, so it stops the run the way a bad key
        // does; read as one unit's failure it left a scan of nothing but file rules printing "nothing to report" and exiting 0.
        if ([401, 402, 403].includes(response.status)) {
          authenticationFailure = new AuthenticationError(response.status, detail, service);
          throw authenticationFailure;
        }
        const accessError = /authenticat|authori[sz]|api[_ -]?key|token[^a-z]+(?:expired|invalid)|quota|rate[_ -]?limit|tokens? per (?:minute|second|day)/i.test(detail);
        const sizedSubject = /\b(?:state|questions?|request(?: body)?|payload|input|prompt)\b[\s\S]{0,100}\b(?:exceed\w*|too (?:long|large)|over the)\b[\s\S]{0,50}(?:\btokens?\b|\blimit\b|\bmaximum\b)|\b(?:request(?: body)?|payload)\b[\s\S]{0,50}\btoo (?:long|large)\b/i.test(detail);
        const sizeError = response.status === 413 || ([400, 422].includes(response.status) && !accessError
          && (sizedSubject || /\b(?:context_length_exceeded|max_tokens_exceeded|context_window_exceeded)\b|\b(?:context (?:length|window)|(?:input|prompt|request) (?:size|length|tokens?|token count))\b[\s\S]{0,100}\b(?:exceed\w*|too (?:long|large)|limit|maximum)\b|\b(?:exceed\w*|maximum)\b[\s\S]{0,80}\b(?:context (?:length|window)|(?:input|prompt|request) (?:size|length|token count))\b/i.test(detail)));
        if (sizeError) throw new ContextLimitError('server rejected the request size; rebuild with fewer estimated tokens', Math.floor(estimateTokens(body.state) / 2));
        throw new Error(`${service} request failed with HTTP ${response.status}: ${detail.slice(0, 500)}`);
      }
      const answer = wire.reply(await response.json(), body);
      learn(answer?._meta);
      answered = true;
      return answer;
    }
  }

  function sendRequest(body, attempted, beforeRequest) {
    if (authenticationFailure) throw new AuthenticationError(authenticationFailure.status, authenticationFailure.detail, service);
    return request(body, attempted, beforeRequest);
  }

  /** A Choice with one option has one possible answer, so it is answered here rather than asked. Some endpoints, Liquid AI's
   * among them, reject a Choice with fewer than two options, and a question with a known answer should cost nothing anyway. */
  function settle(questions) {
    const settled = {}, rest = {};
    for (const [id, question] of Object.entries(questions)) {
      const options = question?.type === 'choice' && question.criteria && !Array.isArray(question.criteria) ? Object.keys(question.criteria) : null;
      if (options?.length === 1) settled[id] = { type: 'choice', choice: options[0], probabilities: { [options[0]]: 1 }, confidence: 1 };
      else rest[id] = question;
    }
    return { settled, rest };
  }

  return {
    id: model,
    limits,
    /** Batch independent questions within the request budget and return one answer per question id. */
    async ask(state, allQuestions, { beforeRequest = () => {} } = {}) {
      const { settled, rest: questions } = settle(allQuestions);
      if (Object.keys(settled).length && !Object.keys(questions).length) return { model, answers: settled, usage: null, requests: 0 };
      const reply = await askAll(state, questions, beforeRequest);
      return Object.keys(settled).length ? { ...reply, answers: { ...reply.answers, ...settled } } : reply;
    },
  };

  async function askAll(state, questions, beforeRequest) {
    const responses = [];
    let requests = 0;
    const usage = () => {
      const sum = {};
      for (const response of responses) for (const [key, value] of Object.entries(response.usage ?? {}))
        if (typeof value === 'number') sum[key] = (sum[key] ?? 0) + value;
      return sum;
    };
    const send = async batch => {
      let response;
      try { response = await sendRequest({ model, state, questions: batch }, () => requests++, beforeRequest); }
      catch (error) {
        if (!(error instanceof ContextLimitError)) throw error;
        const entries = Object.entries(batch);
        log(`${service} rejected the token estimate; ${entries.length > 1 ? 'retrying with fewer questions' : 'reducing the source token budget'}`);
        if (entries.length === 1) throw error;
        if (!entries.length) throw error;
        const middle = Math.ceil(entries.length / 2);
        await send(Object.fromEntries(entries.slice(0, middle)));
        await send(Object.fromEntries(entries.slice(middle)));
        return;
      }
      const missing = Object.keys(batch).filter(id => !response.answers?.[id]);
      if (missing.length) throw new Error(`${service} response is missing answers for ${missing.join(', ')}`);
      responses.push(response);
    };
    try {
      // Until the endpoint has answered once, one request is out at a time and every other ask waits for it. That answer
      // checks the key before concurrent units spend requests on a bad one, and says how many questions the model takes, so
      // nothing is split for it until it has. The first request is kept to `firstQuestions` while that is unknown.
      for (;;) {
        // Checked and claimed in the same tick, so of the asks woken by one answer that did not come, only one sends next.
        if (answered) break;
        if (opening) { await opening; continue; }
        let open;
        opening = new Promise(resolve => { open = resolve; });
        try {
          const [first] = questionBatches(state, questions, { ...limits, questions: Math.min(limits.questions, firstQuestions) });
          await send(first);
          questions = Object.fromEntries(Object.entries(questions).filter(([id]) => !(id in first)));
        } finally { opening = null; open(); }
        break;
      }
      if (Object.keys(questions).length) for (const batch of questionBatches(state, questions, limits)) await send(batch);
    }
    catch (error) {
      error.usage = usage(); error.requests = requests; error.model = responses.at(-1)?.model ?? model;
      throw error;
    }
    const charged = responses.every(response => Number.isSafeInteger(response.charge?.totalNanos) && response.charge.totalNanos >= 0);
    const charge = charged ? { totalNanos: responses.reduce((total, response) => total + response.charge.totalNanos, 0) } : null;
    if (responses.length === 1) return { model: responses[0].model ?? model, answers: responses[0].answers, usage: responses[0].usage ?? null,
      ...(charge ? { charge } : {}), ...(requests > 1 ? { requests } : {}) };
    return { model: responses.at(-1).model ?? model, answers: Object.assign({}, ...responses.map(response => response.answers)), usage: usage(),
      ...(charge ? { charge } : {}), requests };
  }
}
