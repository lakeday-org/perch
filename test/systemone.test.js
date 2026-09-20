import { describe, expect, it } from 'vitest';
import { createSystemOne } from '../src/systemone.js';

const reply = (status, body, headers = {}) => ({ status, ok: status < 400, headers: { get: name => headers[name] }, json: async () => body, text: async () => JSON.stringify(body) });
const answers = { has_bug: { type: 'noul', noul: 0.7 } };

describe('system one client', () => {
  it('posts the state and questions and returns the answers', async () => {
    const requests = [];
    const fetchImpl = async (url, init) => { requests.push({ url, init }); return reply(200, { model: 'jev-1.13.0', answers, usage: { input_tokens: 5, output_tokens: 1 } }); };
    const client = createSystemOne({ apiKey: 'k', model: 'jev-test', fetchImpl });
    const response = await client.ask({ method: 'x' }, { has_bug: { type: 'noul', instructions: 'q', criteria: { true: 'y', false: 'n' } } });
    expect(response).toEqual({ model: 'jev-1.13.0', answers, usage: { input_tokens: 5, output_tokens: 1 } });
    expect(requests[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(requests[0].init.headers.authorization).toBe('Bearer k');
    expect(JSON.parse(requests[0].init.body)).toEqual({ model: 'jev-test', state: { method: 'x' }, questions: { has_bug: { type: 'noul', instructions: 'q', criteria: { true: 'y', false: 'n' } } } });
  });

  it('retries rate limits and overloads, then fails on a bad request', async () => {
    let attempt = 0;
    const fetchImpl = async () => (attempt++ < 2 ? reply(attempt === 1 ? 429 : 529, {}, { 'retry-after': '0' }) : reply(200, { answers }));
    const client = createSystemOne({ apiKey: 'k', fetchImpl, sleep: async () => {}, retryDelayMs: 0 });
    expect((await client.ask({}, { has_bug: { type: 'noul' } })).answers).toEqual(answers);
    expect(attempt).toBe(3);
    const bad = createSystemOne({ apiKey: 'k', fetchImpl: async () => reply(422, { error: 'invalid' }) });
    await expect(bad.ask({}, {})).rejects.toThrow('HTTP 422');
  });

  it.each(['http://localhost:8123/infer', 'http://localhost:8123/infer/', 'http://localhost:8123/infer?version=2'])('posts to the exact configured URL %s', async baseUrl => {
    const requests = [];
    const client = createSystemOne({ apiKey: 'custom-key', model: 'custom-model', baseUrl,
      fetchImpl: async (url, init) => { requests.push({ url, init }); return reply(200, { answers }); } });
    const response = await client.ask({}, { has_bug: { type: 'noul' } });
    expect(requests[0].url).toBe(baseUrl);
    expect(requests[0].init.headers.authorization).toBe('Bearer custom-key');
    expect(JSON.parse(requests[0].init.body).model).toBe('custom-model');
    expect(client.id).toBe('custom-model');
    expect(response.model).toBe('custom-model');
  });

  it('rejects responses missing an answer and requires a key', async () => {
    const client = createSystemOne({ apiKey: 'k', fetchImpl: async () => reply(200, { answers: {} }) });
    await expect(client.ask({}, { has_bug: { type: 'noul' } })).rejects.toThrow('missing answers for has_bug');
    expect(() => createSystemOne({ apiKey: '' })).toThrow('PERCH_API_KEY');
  });
});
