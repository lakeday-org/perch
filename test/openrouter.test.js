import { describe, expect, it } from 'vitest';
import { createOpenRouter, OPENROUTER_WIRE } from '../src/openrouter.js';
import { createMeter, metered } from '../src/meter.js';

const chat = (content, extra = {}) => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ model: 'm/x', choices: [{ message: { content } }], ...extra }) });
const questions = {
  has_bug: { type: 'noul', instructions: 'Is `method` broken?', criteria: { true: 'yes', false: 'no' } },
  kind: { type: 'choice', instructions: 'Which kind?', criteria: { boundary: 'off by one', ordering: 'wrong order' } },
  severity: { type: 'score', instructions: 'How bad?', criteria: ['none', 'some', 'lots'] },
};

describe('openrouter client', () => {
  it('asks for a probability per answer and reads the reply back as System One answers', async () => {
    const requests = [];
    const reply = { has_bug: { p: 1.4 }, kind: { boundary: 3, ordering: 1 }, severity: { 0: 0, 1: 0, 2: 0 } };
    const client = createOpenRouter({ apiKey: 'k', fetchImpl: async (url, init) => { requests.push({ url, init }); return chat('```json\n' + JSON.stringify(reply) + '\n```', { usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.002 } }); } });
    const response = await client.ask({ method: 'x' }, questions);
    expect(requests[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(requests[0].init.headers.authorization).toBe('Bearer k');
    const body = JSON.parse(requests[0].init.body);
    expect(body.model).toBe('openai/gpt-6-luna');
    expect(body.response_format.json_schema.schema.required).toEqual(['has_bug', 'kind', 'severity']);
    expect(body.response_format.json_schema.schema.properties.kind.required).toEqual(['boundary', 'ordering']);
    expect(body.response_format.json_schema.schema.properties.severity.required).toEqual(['0', '1', '2']);
    expect(JSON.parse(body.messages[1].content).questions.severity.criteria).toEqual({ 0: 'none', 1: 'some', 2: 'lots' });
    expect(response.answers).toEqual({
      has_bug: { type: 'noul', noul: 1 },
      kind: { type: 'choice', choice: 'boundary', confidence: 0.75, probabilities: { boundary: 0.75, ordering: 0.25 } },
      severity: { type: 'score', score: 0, confidence: 1 / 3, probabilities: { 0: 1 / 3, 1: 1 / 3, 2: 1 / 3 } },
    });
    expect(response.usage).toEqual({ input_tokens: 7, output_tokens: 3, cost: 0.002 });
  });

  it('prices a run by what OpenRouter charged', async () => {
    const meter = createMeter();
    const client = metered(createOpenRouter({ apiKey: 'k', fetchImpl: async () => chat(JSON.stringify({ has_bug: { p: 0.2 } }), { usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.002 } }) }), meter);
    await client.ask({}, { has_bug: questions.has_bug });
    expect(meter.cost('m/x')).toBe(0.002);
  });

  it('fails a reply that leaves a question out or has no answer at all', async () => {
    const partial = createOpenRouter({ apiKey: 'k', fetchImpl: async () => chat(JSON.stringify({ has_bug: { p: 0.2 } })) });
    await expect(partial.ask({}, questions)).rejects.toThrow('missing answers for kind, severity');
    expect(() => OPENROUTER_WIRE.read({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }, questions)).toThrow('finish reason length');
    expect(() => OPENROUTER_WIRE.read({ error: { message: 'no provider' } }, questions)).toThrow('no provider');
  });
});
