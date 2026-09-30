import { describe, expect, it } from 'vitest';
import { createSystemOne } from '../src/systemone.js';
import { createMeter } from '../src/meter.js';

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

  it.each([
    'the request exceeds the 64k token limit',
    'questions exceed the 32k token limit',
    'state exceeds the 32k token limit per question',
    'The request body is too large',
    'input is over the maximum of 65536 tokens',
  ])('treats %j as a size rejection and asks for a smaller request', async detail => {
    // The subject of a size rejection is whatever the server calls it. Requiring `state` or `question` meant the 64k
    // per-request limit, worded as `request`, fell through to a hard error and the method failed instead of repacking.
    const client = createSystemOne({ apiKey: 'k', fetchImpl: async () => reply(400, { error: detail }) });
    await expect(client.ask({ big: 'x'.repeat(4000) }, { has_bug: { type: 'noul' } })).rejects.toThrow('rejected the request size');
  });

  it.each([
    'Invalid API token; check your plan limits',
    'Your monthly token quota has been exceeded',
  ])('does not mistake %j for a size rejection', async detail => {
    const client = createSystemOne({ apiKey: 'k', fetchImpl: async () => reply(400, { error: detail }) });
    await expect(client.ask({}, { has_bug: { type: 'noul' } })).rejects.toThrow('HTTP 400');
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

  it('answers a Choice with one option itself and asks only the rest', async () => {
    // Liquid AI's endpoint rejects a Choice with fewer than two options; perch asks one about a method with one line.
    const bodies = [];
    const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return reply(200, { model: 'd1:free', answers, usage: { input_tokens: 5, output_tokens: 0 } }); };
    const client = createSystemOne({ apiKey: 'k', model: 'd1:free', fetchImpl, baseUrl: 'https://api.liquid.ai/decisions/v1/systemone' });
    const where = { type: 'choice', instructions: 'Which line?', criteria: { L3: null } };
    const response = await client.ask({ method: 'x' }, { has_bug: { type: 'noul', instructions: 'q' }, where });
    expect(Object.keys(bodies[0].questions)).toEqual(['has_bug']);
    expect(response.answers).toEqual({ ...answers, where: { type: 'choice', choice: 'L3', probabilities: { L3: 1 }, confidence: 1 } });
    expect(response.usage).toEqual({ input_tokens: 5, output_tokens: 0 });
  });

  it('sends nothing when every question has one possible answer', async () => {
    const client = createSystemOne({ apiKey: 'k', fetchImpl: async () => { throw new Error('no request expected'); } });
    const response = await client.ask({}, { follow: { type: 'choice', instructions: 'Which next?', criteria: { none: 'Nothing to follow' } } });
    expect(response).toEqual({ model: 'jev-latest', answers: { follow: { type: 'choice', choice: 'none', probabilities: { none: 1 }, confidence: 1 } }, usage: null, requests: 0 });
  });

  it('prices Perch Cloud answers at its published rate for input and output tokens', () => {
    const meter = createMeter();
    meter.add('perch-latest', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, { requests: 1 });
    expect(meter.cost('perch-latest')).toBeCloseTo(0.1, 10);
  });

  it('prices Liquid AI decision models by family, so a free tier costs nothing rather than an unknown amount', () => {
    const meter = createMeter();
    meter.add('d1:free', { input_tokens: 145000, output_tokens: 0 }, { requests: 21 });
    expect(meter.cost('d1:free')).toBe(0);
  });
});
