import { describe, expect, it } from 'vitest';
import { AuthenticationError, createSystemOne } from '../src/systemone.js';
import { createMeter } from '../src/meter.js';
import { configuredSystemOne, FIRST_QUESTIONS } from '../src/cloud-client.js';
import { runChecks } from '../src/checks.js';

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

  it('prices Liquid AI decision models by family, so a free tier costs nothing rather than an unknown amount', () => {
    const meter = createMeter();
    meter.add('d1:free', { input_tokens: 145000, output_tokens: 0 }, { requests: 21 });
    expect(meter.cost('d1:free')).toBe(0);
  });
  describe('a model that takes fewer questions than a method asks', () => {
    const noul = { type: 'noul', instructions: 'q', criteria: { true: 'y', false: 'n' } };
    const asking = (count, prefix = 'q') => Object.fromEntries(Array.from({ length: count }, (_, at) => [`${prefix}${at}`, noul]));
    /** Beam's models: 32 questions a request, said in `_meta` on every answer, and a refusal for anything over. */
    const beam = (reports = true) => {
      const sizes = [];
      const fetchImpl = async (url, init) => {
        const { questions } = JSON.parse(init.body), count = Object.keys(questions).length;
        sizes.push(count);
        if (count > 32) return reply(422, { detail: `${count} questions; this model takes at most 32 per request` });
        const answers = Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: 0.5 }]));
        return reply(200, { model: 'jev/diffusiongemma', answers, usage: { input_tokens: 1, output_tokens: 0 }, ...(reports ? { _meta: { max_questions: 32, max_options: 128 } } : {}) });
      };
      return { sizes, fetchImpl };
    };

    it('reads a method of 36 questions without one refused request, learning the limit from the first answer', async () => {
      const { sizes, fetchImpl } = beam();
      const client = createSystemOne({ apiKey: 'k', fetchImpl, firstQuestions: FIRST_QUESTIONS });
      const response = await client.ask({ method: 'x' }, asking(36));
      expect(Object.keys(response.answers)).toHaveLength(36);
      expect(sizes[0]).toBeLessThanOrEqual(FIRST_QUESTIONS);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(32);
      expect(client.limits.questions).toBe(32);
    });

    it('holds every concurrent method until the first answer has said how many questions fit', async () => {
      // A scan sends 32 methods at once. Each one split its questions before anything had come back, so all but the first went
      // out sized for Jev and were refused.
      const { sizes, fetchImpl } = beam();
      const client = createSystemOne({ apiKey: 'k', fetchImpl, firstQuestions: FIRST_QUESTIONS });
      const readings = await Promise.all(['a', 'b', 'c', 'd'].map(prefix => client.ask({ method: prefix }, asking(36, prefix))));
      expect(readings.every(reading => Object.keys(reading.answers).length === 36)).toBe(true);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(32);
    });

    it('takes the limit from PERCH_MAX_QUESTIONS when the model does not say', async () => {
      const { sizes, fetchImpl } = beam(false);
      const client = await configuredSystemOne({ env: { PERCH_BASE_URL: 'https://app.beam.cloud/v1/models/jev/semif/invoke', PERCH_API_KEY: 'k',
        PERCH_MODEL_ID: 'jev/semif', PERCH_MAX_QUESTIONS: '10' }, fetchImpl });
      await client.ask({ method: 'x' }, asking(36));
      expect(sizes).toEqual([10, 10, 10, 6]);
      await expect(configuredSystemOne({ env: { PERCH_BASE_URL: 'https://example.test', PERCH_API_KEY: 'k', PERCH_MAX_QUESTIONS: 'lots' }, fetchImpl }))
        .rejects.toThrow('PERCH_MAX_QUESTIONS must be a whole number');
    });

    it('refuses a choice with more options than the model takes', async () => {
      const { fetchImpl } = beam();
      const client = createSystemOne({ apiKey: 'k', fetchImpl, limits: { options: 16 } });
      const wide = { type: 'choice', instructions: 'which', criteria: Object.fromEntries(Array.from({ length: 17 }, (_, at) => [`o${at}`, `option ${at}`])) };
      await expect(client.ask({ method: 'x' }, { kind: wide })).rejects.toThrow('more than 16 choices');
    });
  });
});

describe("OpenAI's Decisions API", () => {
  const url = 'https://api.openai.com/v1/decisions';
  // What gpt-6-luna sent back for these three shapes, trimmed.
  const decided = {
    model: 'gpt-6-luna',
    answers: [
      { type: 'choice', name: 'has_bug', choice: 'true', probabilities: [{ value: 'true', probability: 0.99 }, { value: 'false', probability: 0.01 }], confidence: 0.98 },
      { type: 'choice', name: 'kind', choice: 'logic', probabilities: [{ value: 'logic', probability: 0.72 }, { value: 'none', probability: 0.08 }, { value: 'none_of_these', probability: 0.2 }], confidence: 0.8 },
      { type: 'score', name: 'severity', score: 0.86, probabilities: [{ value: 0, label: '0', probability: 0.14 }, { value: 1, label: '1', probability: 0.86 }], confidence: 0.72 },
    ],
    usage: { input_tokens: 391, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 0, total_tokens: 391 },
  };
  const questions = {
    has_bug: { type: 'noul', instructions: 'Is it broken?', criteria: { true: 'It returns the wrong value', false: 'It returns the sum' } },
    kind: { type: 'choice', instructions: 'What kind?', criteria: { logic: 'Wrong operator', none: null } },
    severity: { type: 'score', instructions: 'How bad?', criteria: ['No caller would notice', 'A wrong result in ordinary use'] },
  };

  it('asks in its format and reads the answers back as System One gives them', async () => {
    const requests = [];
    const client = createSystemOne({ apiKey: 'sk', baseUrl: url, fetchImpl: async (to, init) => { requests.push({ to, init }); return reply(200, decided); } });
    const response = await client.ask({ method: { name: 'add', source: 'return a - b' } }, questions);
    expect(requests[0].to).toBe(url);
    expect(JSON.parse(requests[0].init.body)).toEqual({
      model: 'gpt-6-luna',
      input: JSON.stringify({ method: { name: 'add', source: 'return a - b' } }),
      questions: [
        { type: 'choice', name: 'has_bug', instructions: 'Is it broken?', choices: [{ value: 'true', description: 'It returns the wrong value' }, { value: 'false', description: 'It returns the sum' }] },
        { type: 'choice', name: 'kind', instructions: 'What kind?',
          choices: [{ value: 'logic', description: 'Wrong operator' }, { value: 'none', description: 'none' }, { value: 'none_of_these', description: 'None of these fits' }] },
        { type: 'score', name: 'severity', instructions: 'How bad?', levels: [{ label: '0', description: 'No caller would notice' }, { label: '1', description: 'A wrong result in ordinary use' }] },
      ],
    });
    expect(response.model).toBe('gpt-6-luna');
    expect(response.answers).toEqual({
      has_bug: { type: 'noul', noul: 0.99 },
      kind: { type: 'choice', choice: 'logic', probabilities: { logic: 0.9, none: 0.1 }, confidence: 0.8 },
      severity: { type: 'score', score: 0.86, probabilities: { 0: 0.14, 1: 0.86 }, confidence: 0.72 },
    });
    expect(client.id).toBe('gpt-6-luna');
    expect(client.limits.questions).toBe(200);
  });

  it('asks a noul without criteria as a predicate', async () => {
    let sent;
    const client = createSystemOne({ apiKey: 'sk', baseUrl: url, fetchImpl: async (_, init) => {
      sent = JSON.parse(init.body);
      return reply(200, { model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'has_break', probability: 0.3 }] });
    } });
    const response = await client.ask({ source: 'x' }, { has_break: { type: 'noul', instructions: 'Is the rule broken here?' } });
    expect(sent.questions).toEqual([{ type: 'predicate', name: 'has_break', instructions: 'Is the rule broken here?' }]);
    expect(response.answers).toEqual({ has_break: { type: 'noul', noul: 0.3 } });
  });

  it('picks the likeliest option asked about when the fallback was likeliest', async () => {
    // `kind` asks which defect a method has, and has no option for none. Without a fallback the API refused it outright.
    const client = createSystemOne({ apiKey: 'sk', baseUrl: url, fetchImpl: async () => reply(200, { model: 'gpt-6-luna', answers: [{ type: 'choice', name: 'kind', choice: 'none_of_these',
      probabilities: [{ value: 'boundary', probability: 0.15 }, { value: 'wrong_return', probability: 0.05 }, { value: 'none_of_these', probability: 0.8 }], confidence: 0.6 }] }) });
    const { answers } = await client.ask({}, { kind: { type: 'choice', instructions: 'Which kind?', criteria: { boundary: 'Off by one', wrong_return: 'Wrong value' } } });
    expect(answers.kind.choice).toBe('boundary');
    expect(answers.kind.probabilities.boundary).toBeCloseTo(0.75);
    expect(answers.kind.probabilities.wrong_return).toBeCloseTo(0.25);
  });

  it('says which graph node a role in an instruction is, since an instruction is one string', async () => {
    let sent;
    const client = createSystemOne({ apiKey: 'sk', baseUrl: url, fetchImpl: async (_, init) => {
      sent = JSON.parse(init.body);
      return reply(200, { model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'misuse_0', probability: 0.2 }] });
    } });
    await client.ask({}, { misuse_0: { type: 'noul', instructions: { callee: 'src/a.js::parse', question: 'Does `method` misuse `callee`?' } } });
    expect(sent.questions[0].instructions).toBe('`callee` is src/a.js::parse in graph.nodes. Does `method` misuse `callee`?');
  });

  it('fails a reading the model declined, naming the question', async () => {
    const client = createSystemOne({ apiKey: 'sk', baseUrl: url,
      fetchImpl: async () => reply(200, { model: 'gpt-6-luna', answers: [{ type: 'choice', name: 'has_bug', choice: 'false', probabilities: [{ value: 'true', probability: 0.4 }, { value: 'false', probability: 0.6 }] }, { type: 'refusal', name: 'kind' }] }) });
    await expect(client.ask({}, { has_bug: questions.has_bug, kind: questions.kind })).rejects.toThrow('gpt-6-luna declined to answer kind');
  });

  it('stops the run on an account out of credit rather than retrying it', async () => {
    let calls = 0;
    const quota = { error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' } };
    const client = createSystemOne({ apiKey: 'sk', baseUrl: url, sleep: async () => {}, fetchImpl: async () => { calls++; return reply(429, quota); } });
    await expect(client.ask({}, { has_bug: questions.has_bug })).rejects.toThrow(AuthenticationError);
    await expect(client.ask({}, { has_bug: questions.has_bug })).rejects.toThrow('Decisions API request failed with HTTP 429');
    expect(calls).toBe(1);
  });

  it('takes OPENAI_API_KEY when PERCH_API_KEY is not set, and doctor says so', async () => {
    let authorization;
    const env = { PERCH_BASE_URL: url, OPENAI_API_KEY: 'sk-openai', TYPESAFE_API_KEY: 'ts' };
    const client = await configuredSystemOne({ env, fetchImpl: async (_, init) => { authorization = init.headers.authorization; return reply(200, decided); } });
    await client.ask({}, questions);
    expect(authorization).toBe('Bearer sk-openai');
    const checks = await runChecks({ root: process.cwd(), out: '.perch', env, versions: { node: process.version }, credential: 'direct' });
    expect(checks.find(check => check.name === 'key').found).toBe(`OPENAI_API_KEY, 9 characters, for ${url}`);
  });

  it('prices gpt-6-luna at its own published rate and not as every gpt model', () => {
    const meter = createMeter();
    meter.add('gpt-6-luna', { input_tokens: 2_000_000, output_tokens: 0 });
    meter.add('gpt-7', { input_tokens: 1000, output_tokens: 0 });
    expect(meter.cost('gpt-6-luna')).toBeCloseTo(0.2);
    expect(meter.cost('gpt-7')).toBeNull();
  });
});
