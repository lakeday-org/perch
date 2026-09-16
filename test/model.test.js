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
const proposal = { method: 'function f() {}', test: 'test', test_path: 'test/f.test.js', summary: 'fixed' };

describe('model', () => {
  it('sends a strict schema request and parses a valid response', async () => {
    const { fetchImpl, requests } = fakeFetch(() => json(completed(proposal)));
    const model = createModel({ ...options, fetchImpl });
    expect(model.id).toBe('test-model');
    const value = await model.ask('fix-1', 'please fix', { maxOutputTokens: 4096 });
    expect(value).toEqual(proposal);
    expect(requests).toHaveLength(1);
    const [{ url, headers, body }] = requests;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(body).toMatchObject({ model: 'test-model', input: 'please fix', store: false, max_output_tokens: 4096, reasoning: { effort: 'none' },
      text: { format: { type: 'json_schema', name: 'fix', strict: true, schema: { additionalProperties: false, required: ['method', 'test', 'test_path', 'summary'] } } } });
    expect(body.background).toBeUndefined();
    expect(model.last).toMatchObject({ effort: 'none' });
    await model.ask('fix-2', 'again', { effort: 'medium' });
    expect(requests.at(-1).body.reasoning).toEqual({ effort: 'medium' });
    expect(createModel({ ...options, effort: 'low', fetchImpl }).effort).toBe('low');
    expect(() => createModel({ ...options, effort: 'max', fetchImpl })).toThrow('--effort must be one of');
  });

  it('rejects responses that violate the schema', async () => {
    const { fetchImpl } = fakeFetch(() => json(completed({ ...proposal, method: 42 })));
    await expect(createModel({ ...options, fetchImpl }).ask('fix-1', 'x')).rejects.toThrow('violated its schema');
    const { fetchImpl: extra } = fakeFetch(() => json(completed({ ...proposal, extra: 1 })));
    await expect(createModel({ ...options, fetchImpl: extra }).ask('fix-1', 'x')).rejects.toThrow('violated its schema');
    const { fetchImpl: refusal } = fakeFetch(() => json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }));
    await expect(createModel({ ...options, fetchImpl: refusal }).ask('fix-1', 'x')).rejects.toThrow('refused');
    expect(() => responseValue(completed('not an object'), responseFormat('fix-1'))).toThrow('violated its schema');
    expect(() => responseFormat('review-1')).toThrow('Unknown inference response contract');
  });

  it('retries an incomplete response with a larger max_output_tokens', async () => {
    const { fetchImpl, requests } = fakeFetch((body, n) => n === 1
      ? json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] })
      : json(completed(proposal)));
    const value = await createModel({ ...options, fetchImpl }).ask('fix-1', 'fix it');
    expect(value).toEqual(proposal);
    expect(requests.map(request => request.body.max_output_tokens)).toEqual([16384, 32768]);
  });

  it('gives up on an incomplete response at the token ceiling', async () => {
    const { fetchImpl, requests } = fakeFetch(() => json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }));
    await expect(createModel({ ...options, fetchImpl }).ask('fix-1', 'fix it')).rejects.toThrow('ended with incomplete');
    expect(requests.map(request => request.body.max_output_tokens)).toEqual([16384, 32768]);
  });

  it('retries 429 and 5xx responses with backoff, then fails', async () => {
    const slept = [];
    const { fetchImpl, requests } = fakeFetch((body, n) => n === 1 ? json({ error: 'slow down' }, 429, { 'retry-after': '1' }) : n === 2 ? json({ error: 'oops' }, 503) : json(completed(proposal)));
    const value = await createModel({ ...options, fetchImpl, sleep: async ms => { slept.push(ms); } }).ask('fix-2', 'x');
    expect(value).toEqual(proposal);
    expect(requests).toHaveLength(3);
    expect(slept).toEqual([1000, 2]);

    const always = fakeFetch(() => json({ error: 'busy' }, 429));
    await expect(createModel({ ...options, fetchImpl: always.fetchImpl }).ask('fix-2', 'x')).rejects.toThrow('HTTP 429');
    expect(always.requests).toHaveLength(4);
  });

  it('requires an API key', () => {
    expect(() => createModel({ apiKey: '', fetchImpl: async () => {} })).toThrow('OPENAI_API_KEY');
  });
});
