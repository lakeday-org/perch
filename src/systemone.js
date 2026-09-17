/** TypeSafe System One client: typed questions over a state, answered with probabilities. */

export const DEFAULT_SYSTEM_ONE_MODEL = 'jev-latest';

export function createSystemOne({
  apiKey,
  model = DEFAULT_SYSTEM_ONE_MODEL,
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.typesafe.ai/v1',
  retryDelayMs = 2000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = () => {},
} = {}) {
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set. Export a TypeSafe API key before running perch scan.');

  async function request(body) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/systemone`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
    /** Ask every question in one call; returns { model, answers, usage } with one answer per question id. */
    async ask(state, questions) {
      const response = await request({ model, state, questions });
      const missing = Object.keys(questions).filter(id => !response.answers?.[id]);
      if (missing.length) throw new Error(`System One response is missing answers for ${missing.join(', ')}`);
      return { model: response.model ?? model, answers: response.answers, usage: response.usage ?? null };
    },
  };
}
