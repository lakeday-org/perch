/** TypeSafe System One client: typed questions over a state, answered with probabilities. */
import { createHash } from 'node:crypto';
import { questionBatches } from './chunks.js';

export const DEFAULT_SYSTEM_ONE_MODEL = 'jev-latest';

export function createSystemOne({
  apiKey,
  model = DEFAULT_SYSTEM_ONE_MODEL,
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.typesafe.ai/v1/systemone',
  retryDelayMs = 2000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = () => {},
} = {}) {
  if (!apiKey) throw new Error('PERCH_API_KEY is not set. Export an API key before running perch scan or perch check.');

  async function request(body) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
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
      if (!response.ok) throw new Error(`System One request failed with HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 500)}`);
      return response.json();
    }
  }

  return {
    id: model,
    cacheKey: createHash('sha256').update(JSON.stringify([baseUrl, model])).digest('hex'),
    /** Batch independent questions within the request budget and return one answer per question id. */
    async ask(state, questions) {
      const responses = [];
      for (const batch of questionBatches(state, questions)) {
        const response = await request({ model, state, questions: batch });
        const missing = Object.keys(batch).filter(id => !response.answers?.[id]);
        if (missing.length) throw new Error(`System One response is missing answers for ${missing.join(', ')}`);
        responses.push(response);
      }
      if (responses.length === 1) return { model: responses[0].model ?? model, answers: responses[0].answers, usage: responses[0].usage ?? null };
      const usage = {};
      for (const response of responses) for (const [key, value] of Object.entries(response.usage ?? {}))
        if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
      return { model: responses.at(-1).model ?? model, answers: Object.assign({}, ...responses.map(response => response.answers)), usage, requests: responses.length };
    },
  };
}
