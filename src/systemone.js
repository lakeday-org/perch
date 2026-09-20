/** TypeSafe System One client: typed questions over a state, answered with probabilities. */
import { createHash } from 'node:crypto';
import { questionBatches, estimateTokens, TOKEN_LIMITS, ContextLimitError } from './tokens.js';

export const DEFAULT_SYSTEM_ONE_MODEL = 'jev-latest';

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

  async function request(body, attempted) {
    for (let attempt = 0; ; attempt++) {
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
        const sizeError = response.status === 413 || ([400, 422].includes(response.status)
          && /context_length_exceeded|max_tokens_exceeded|(?:token|context)[\s\S]{0,80}(?:exceed|too (?:long|large)|limit)|(?:exceed|maximum)[\s\S]{0,80}(?:tokens|context length)/i.test(detail));
        if (sizeError) throw new ContextLimitError('server rejected the request size; rebuild with fewer estimated tokens', Math.floor(estimateTokens(body.state) / 2));
        throw new Error(`System One request failed with HTTP ${response.status}: ${detail.slice(0, 500)}`);
      }
      return response.json();
    }
  }

  return {
    id: model,
    limits,
    cacheKey: createHash('sha256').update(JSON.stringify([baseUrl, model, limits, 'token-estimates-v1'])).digest('hex'),
    /** Batch independent questions within the request budget and return one answer per question id. */
    async ask(state, questions) {
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
        try { response = await request({ model, state, questions: batch }, () => requests++); }
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
