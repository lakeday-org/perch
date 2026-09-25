/** TypeSafe System One client: typed questions over a state, answered with probabilities. */
import { questionBatches, estimateTokens, TOKEN_LIMITS, ContextLimitError } from './tokens.js';

export const DEFAULT_SYSTEM_ONE_MODEL = 'jev-latest';

/** Credentials apply to the whole run, so trying another file cannot repair their rejection. */
export class AuthenticationError extends Error {
  constructor(status, detail) {
    super(`System One request failed with HTTP ${status}: ${detail.slice(0, 500)}`);
    this.name = 'AuthenticationError'; this.status = status; this.detail = detail;
  }
}

export function createSystemOne({
  apiKey,
  model = DEFAULT_SYSTEM_ONE_MODEL,
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.typesafe.ai/v1/systemone',
  retryDelayMs = 2000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = () => {},
  limits = TOKEN_LIMITS,
} = {}) {
  if (!apiKey) throw new Error('PERCH_API_KEY is not set. Export an API key before running perch scan or perch check.');
  let authenticationFailure = null, firstRequest = null;

  async function request(body, attempted, beforeRequest) {
    for (let attempt = 0; ; attempt++) {
      if (authenticationFailure) throw new AuthenticationError(authenticationFailure.status, authenticationFailure.detail);
      beforeRequest();
      let response;
      try {
        attempted();
        response = await fetchImpl(baseUrl, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      } catch (error) {
        if (attempt >= 3) throw error;
        log(`System One request failed (${error.message}); retrying`);
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= 3) throw new Error(`System One request failed with HTTP ${response.status} after four attempts`);
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        log(`System One returned HTTP ${response.status}; retrying`);
        await sleep(retryAfter > 0 ? retryAfter * 1000 : retryDelayMs * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 2000);
        // 402 is the account out of credits. Every request will get the same answer, so it stops the run the way a bad key
        // does; read as one unit's failure it left a scan of nothing but file rules printing "nothing to report" and exiting 0.
        if ([401, 402, 403].includes(response.status)) {
          authenticationFailure = new AuthenticationError(response.status, detail);
          throw authenticationFailure;
        }
        const accessError = /authenticat|authori[sz]|api[_ -]?key|token[^a-z]+(?:expired|invalid)|quota|rate[_ -]?limit|tokens? per (?:minute|second|day)/i.test(detail);
        const sizedSubject = /\b(?:state|questions?|request(?: body)?|payload|input|prompt)\b[\s\S]{0,100}\b(?:exceed\w*|too (?:long|large)|over the)\b[\s\S]{0,50}(?:\btokens?\b|\blimit\b|\bmaximum\b)|\b(?:request(?: body)?|payload)\b[\s\S]{0,50}\btoo (?:long|large)\b/i.test(detail);
        const sizeError = response.status === 413 || ([400, 422].includes(response.status) && !accessError
          && (sizedSubject || /\b(?:context_length_exceeded|max_tokens_exceeded|context_window_exceeded)\b|\b(?:context (?:length|window)|(?:input|prompt|request) (?:size|length|tokens?|token count))\b[\s\S]{0,100}\b(?:exceed\w*|too (?:long|large)|limit|maximum)\b|\b(?:exceed\w*|maximum)\b[\s\S]{0,80}\b(?:context (?:length|window)|(?:input|prompt|request) (?:size|length|token count))\b/i.test(detail)));
        if (sizeError) throw new ContextLimitError('server rejected the request size; rebuild with fewer estimated tokens', Math.floor(estimateTokens(body.state) / 2));
        throw new Error(`System One request failed with HTTP ${response.status}: ${detail.slice(0, 500)}`);
      }
      return response.json();
    }
  }

  /** The first real request checks credentials before concurrent units can spend requests on the same bad key. */
  async function sendRequest(body, attempted, beforeRequest) {
    if (firstRequest) await firstRequest;
    if (authenticationFailure) throw new AuthenticationError(authenticationFailure.status, authenticationFailure.detail);
    const pending = request(body, attempted, beforeRequest);
    firstRequest ??= pending.then(() => {}, () => {});
    return pending;
  }

  return {
    id: model,
    limits,
    /** Batch independent questions within the request budget and return one answer per question id. */
    async ask(state, questions, { beforeRequest = () => {} } = {}) {
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
          log(`System One rejected the token estimate; ${entries.length > 1 ? 'retrying with fewer questions' : 'reducing the source token budget'}`);
          if (entries.length === 1) throw error;
          if (!entries.length) throw error;
          const middle = Math.ceil(entries.length / 2);
          await send(Object.fromEntries(entries.slice(0, middle)));
          await send(Object.fromEntries(entries.slice(middle)));
          return;
        }
        const missing = Object.keys(batch).filter(id => !response.answers?.[id]);
        if (missing.length) throw new Error(`System One response is missing answers for ${missing.join(', ')}`);
        responses.push(response);
      };
      try { for (const batch of questionBatches(state, questions, limits)) await send(batch); }
      catch (error) {
        error.usage = usage(); error.requests = requests; error.model = responses.at(-1)?.model ?? model;
        throw error;
      }
      if (responses.length === 1) return { model: responses[0].model ?? model, answers: responses[0].answers, usage: responses[0].usage ?? null, ...(requests > 1 ? { requests } : {}) };
      return { model: responses.at(-1).model ?? model, answers: Object.assign({}, ...responses.map(response => response.answers)), usage: usage(), requests };
    },
  };
}
