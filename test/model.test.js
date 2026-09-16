import { describe, expect, it } from 'vitest';
import { createModel, describeRun, tool } from '../src/model.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function fakeFetch(handler) {
  const requests = [];
  const fetchImpl = async (url, init) => { const body = JSON.parse(init.body); requests.push({ url, headers: init.headers, body }); return handler(body, requests.length); };
  return { fetchImpl, requests };
}
const options = { apiKey: 'sk-test', model: 'test-model', retryDelayMs: 1, sleep: async () => {} };
const call = (id, name, args) => ({ type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args) });
const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] };
const completed = (output, usage = { input_tokens: 100, output_tokens: 10 }) => ({ id: 'resp', status: 'completed', output, usage });

describe('model', () => {
  it('runs the model as an agent: declares the tools, executes each call, feeds the result back, and stops at a done tool', async () => {
    const seen = [];
    const tools = [
      tool('check', 'Check it.', { source: { type: 'string' } }, async ({ source }) => { seen.push(source); return { ok: source !== 'bad' }; }),
      tool('submit', 'Finish.', { source: { type: 'string' } }, async ({ source }) => (seen.includes(source) ? { ok: true, done: true } : { ok: false, error: 'check first' })),
    ];
    const { fetchImpl, requests } = fakeFetch((body, n) => n === 1 ? json(completed([reasoning, call(1, 'check', { source: 'bad' })]))
      : n === 2 ? json(completed([call(2, 'check', { source: 'good' }), call(3, 'submit', { source: 'good' })], { input_tokens: 200, input_tokens_details: { cached_tokens: 150 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } }))
      : json(completed([])));
    const model = createModel({ ...options, effort: 'low', fetchImpl });
    const events = [];
    const run = await model.run({ prompt: 'fix it', tools, onEvent: event => events.push(event.type) });
    expect(run.done).toBe(true);
    expect(run.turns).toBe(2);
    expect(run.usage).toEqual({ input_tokens: 300, cached_tokens: 150, output_tokens: 30, reasoning_tokens: 5 });
    expect(describeRun(run)).toBe('2 turns, 0k in (0k cached) / 0k out, 0k reasoning');
    const first = requests[0].body;
    expect(first).toMatchObject({ model: 'test-model', store: false, include: ['reasoning.encrypted_content'], tool_choice: 'auto', reasoning: { effort: 'low' }, input: [{ role: 'user', content: 'fix it' }] });
    expect(first.tools.map(item => item.name)).toEqual(['check', 'submit']);
    expect(first.tools[0]).toMatchObject({ type: 'function', strict: true, parameters: { type: 'object', required: ['source'], additionalProperties: false } });
    expect(first.tools[0].handler).toBeUndefined();
    // The second request carries the model's own items back (reasoning included) with the tool output appended.
    const second = requests[1].body.input;
    expect(second.map(item => item.type ?? item.role)).toEqual(['user', 'reasoning', 'function_call', 'function_call_output']);
    expect(JSON.parse(second[3].output)).toEqual({ ok: false });
    expect(seen).toEqual(['bad', 'good']);
    expect(events).toEqual(['request', 'response', 'tool_call', 'tool_result', 'request', 'response', 'tool_call', 'tool_result', 'tool_call', 'tool_result']);
    expect(run.trace.filter(event => event.type === 'tool_result').map(event => event.result)).toEqual([{ ok: false }, { ok: true }, { ok: true, done: true }]);
  });

  it('nudges a turn with no tool call, reports unknown tools and bad arguments, and stops at the turn limit', async () => {
    const tools = [tool('submit', 'Finish.', { source: { type: 'string' } }, async () => ({ ok: true, done: true }))];
    const { fetchImpl, requests } = fakeFetch((body, n) => n === 1 ? json(completed([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'thinking out loud' }] }]))
      : n === 2 ? json(completed([call(1, 'nope', {}), { ...call(2, 'submit', {}), arguments: '{not json' }]))
      : json(completed([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'still talking' }] }])));
    const run = await createModel({ ...options, fetchImpl }).run({ prompt: 'x', tools, maxTurns: 3 });
    expect(run.done).toBe(false);
    expect(run.turns).toBe(3);
    expect(requests[1].body.input.at(-1)).toEqual({ role: 'user', content: 'Continue with a tool call: check your source with the verifiers, then call submit. Prose is not read.' });
    expect(run.trace.filter(event => event.type === 'tool_result').map(event => event.result.error)).toEqual(['unknown tool nope', 'arguments were not valid JSON']);
    expect(run.trace.filter(event => event.type === 'message')).toHaveLength(2);
  });

  it('retries 429 and 5xx responses with backoff, then fails, and reasons at medium by default', async () => {
    const tools = [tool('submit', 'Finish.', { source: { type: 'string' } }, async () => ({ ok: true, done: true }))];
    const slept = [];
    const { fetchImpl, requests } = fakeFetch((body, n) => n === 1 ? json({ error: 'slow down' }, 429, { 'retry-after': '1' }) : n === 2 ? json({ error: 'oops' }, 503) : json(completed([call(1, 'submit', { source: 's' })])));
    const run = await createModel({ ...options, fetchImpl, sleep: async ms => { slept.push(ms); } }).run({ prompt: 'x', tools });
    expect(run.done).toBe(true);
    expect(requests).toHaveLength(3);
    expect(slept).toEqual([1000, 2]);
    expect(requests[2].body.reasoning).toEqual({ effort: 'medium' });
    // Several checks of the same source belong in one turn; the handlers run in the order the model gives them.
    expect(requests[2].body.parallel_tool_calls).toBe(true);
    const always = fakeFetch(() => json({ error: 'busy' }, 429));
    await expect(createModel({ ...options, fetchImpl: always.fetchImpl }).run({ prompt: 'x', tools })).rejects.toThrow('HTTP 429');
    expect(always.requests).toHaveLength(4);
  });

  it('requires an API key and a known effort', () => {
    expect(() => createModel({ apiKey: '', fetchImpl: async () => {} })).toThrow('OPENAI_API_KEY');
    expect(() => createModel({ ...options, effort: 'ultra', fetchImpl: async () => {} })).toThrow('--effort must be one of');
    expect(createModel({ ...options, effort: 'xhigh', fetchImpl: async () => {} }).effort).toBe('xhigh');
  });
});
