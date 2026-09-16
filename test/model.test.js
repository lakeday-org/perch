import { describe, expect, it } from 'vitest';
import { createModel, responseFormat, responseValue } from '../src/model.js';

const completed = (value, extra = {}) => ({ id: 'resp_1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], ...extra });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeFetch(handler) {
  const requests = [];
  const fetchImpl = async (url, init) => { const body = JSON.parse(init.body); requests.push({ url, headers: init.headers, body }); return handler(body, requests.length); };
  return { fetchImpl, requests };
}

const options = { apiKey: 'sk-test', model: 'test-model', retryDelayMs: 1, sleep: async () => {} };

describe('model', () => {
  it('sends a strict schema request and parses a valid response', async () => {
    const { fetchImpl, requests } = fakeFetch(() => json(completed({ approved: true, reason: 'fine' })));
    const model = createModel({ ...options, fetchImpl });
    expect(model.id).toBe('test-model');
    const value = await model.ask('review-0', 'please review', { maxOutputTokens: 4096 });
    expect(value).toEqual({ approved: true, reason: 'fine' });
    expect(requests).toHaveLength(1);
    const [{ url, headers, body }] = requests;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(body).toMatchObject({ model: 'test-model', input: 'please review', store: false, max_output_tokens: 4096, reasoning: { effort: 'high' },
      text: { format: { type: 'json_schema', name: 'review', strict: true, schema: { additionalProperties: false, required: ['approved', 'reason'] } } } });
    expect(body.background).toBeUndefined();
  });

  it('uses medium reasoning for preparation', async () => {
    const { fetchImpl, requests } = fakeFetch(() => json(completed({ setup: 'true', baseline: 'npm test' })));
    await createModel({ ...options, fetchImpl }).ask('preparation-0', 'prepare');
    expect(requests[0].body.reasoning).toEqual({ effort: 'medium' });
    expect(requests[0].body.max_output_tokens).toBe(16384);
  });

  it('rejects responses that violate the schema', async () => {
    const { fetchImpl } = fakeFetch(() => json(completed({ approved: 'yes', reason: 'fine' })));
    await expect(createModel({ ...options, fetchImpl }).ask('review-0', 'x')).rejects.toThrow('violated its schema');
    const { fetchImpl: extra } = fakeFetch(() => json(completed({ approved: true, reason: 'fine', extra: 1 })));
    await expect(createModel({ ...options, fetchImpl: extra }).ask('review-0', 'x')).rejects.toThrow('violated its schema');
    const { fetchImpl: refusal } = fakeFetch(() => json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }));
    await expect(createModel({ ...options, fetchImpl: refusal }).ask('review-0', 'x')).rejects.toThrow('refused');
    expect(() => responseValue(completed('not an object'), responseFormat('fix-0-0'))).toThrow('violated its schema');
  });

  it('retries an incomplete response with a larger max_output_tokens', async () => {
    const { fetchImpl, requests } = fakeFetch((body, n) => n === 1
      ? json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] })
      : json(completed({ source: 'x', summary: 'y' })));
    const value = await createModel({ ...options, fetchImpl }).ask('fix-0-0', 'fix it');
    expect(value).toEqual({ source: 'x', summary: 'y' });
    expect(requests.map(request => request.body.max_output_tokens)).toEqual([16384, 32768]);
  });

  it('gives up on an incomplete response at the token ceiling', async () => {
    const { fetchImpl, requests } = fakeFetch(() => json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }));
    await expect(createModel({ ...options, fetchImpl }).ask('fix-0-0', 'fix it')).rejects.toThrow('ended with incomplete');
    expect(requests.map(request => request.body.max_output_tokens)).toEqual([16384, 32768]);
  });

  it('retries 429 and 5xx responses with backoff, then fails', async () => {
    const slept = [];
    const { fetchImpl, requests } = fakeFetch((body, n) => n === 1 ? json({ error: 'slow down' }, 429, { 'retry-after': '1' }) : n === 2 ? json({ error: 'oops' }, 503) : json(completed({ approved: false, reason: 'meh' })));
    const value = await createModel({ ...options, fetchImpl, sleep: async ms => { slept.push(ms); } }).ask('review-1', 'x');
    expect(value).toEqual({ approved: false, reason: 'meh' });
    expect(requests).toHaveLength(3);
    expect(slept).toEqual([1000, 2]);

    const always = fakeFetch(() => json({ error: 'busy' }, 429));
    await expect(createModel({ ...options, fetchImpl: always.fetchImpl }).ask('review-1', 'x')).rejects.toThrow('HTTP 429');
    expect(always.requests).toHaveLength(4);
  });

  it('requires an API key', () => {
    expect(() => createModel({ apiKey: '', fetchImpl: async () => {} })).toThrow('OPENAI_API_KEY');
  });
});
