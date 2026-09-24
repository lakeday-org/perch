import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { addRule, editRule, removeRule } from '../src/rules.js';
import { createSystemOne } from '../src/systemone.js';
import { parseQuestions } from '../src/ask.js';
import { askUnitSteps, unitSteps } from '../src/units.js';
import { scanRepository } from '../src/scan.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { main } from '../src/cli.js';
import { TOKEN_LIMITS } from '../src/tokens.js';
import { commitAll, makeGraphFixture, scriptedSystemOne } from './helpers.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const reply = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body), json: async () => body });

it('adds, edits, and removes rules before the first commit and still detects local split duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perch-unborn-')); roots.push(root);
  await git(['init', '-q', root]);
  await addRule(root, { name: 'r1', where: '**/*', ensure: 'The code validates input.' });
  await editRule(root, 'r1', { ensure: 'The code handles invalid input.' });
  expect(await readFile(join(root, 'perch.yaml'), 'utf8')).toContain('handles invalid input');
  await removeRule(root, 'r1');
  expect(parseQuestions(await readFile(join(root, 'perch.yaml'), 'utf8'), 'fixture', 'rule')).toEqual([]);
  await mkdir(join(root, '.perch/rules'), { recursive: true });
  await writeFile(join(root, '.perch/rules/local.yaml'), '- name: duplicate\n  where: "**/*"\n  ensure: The code validates input.\n');
  await expect(addRule(root, { name: 'duplicate', where: '**/*', ensure: 'The code handles input.' })).rejects.toThrow('already a rule');
});

it.each(['state exceeds the 32k token limit', 'question exceeds 32000 tokens', 'request body is too large'])('shrinks source after the server reports %s', async message => {
  const rules = parseQuestions('- name: r\n  where: example.js\n  ensure: The code handles input.\n', 'fixture', 'rule');
  const source = 'function run() {\n' + '  handle(input);\n'.repeat(150) + '}';
  const states = [];
  const systemOne = createSystemOne({ apiKey: 'fixture', fetchImpl: async (_url, init) => {
    const { state, questions } = JSON.parse(init.body); states.push(state);
    return states.length === 1 ? reply(400, {error:message}) : reply(200, {answers:Object.fromEntries(Object.keys(questions).map(key => [key,{noul:0.99}]))});
  } });
  const prepare = budget => unitSteps({ rules, unit: {path:'example.js',line:1}, source, budget });
  const result = await askUnitSteps({systemOne, rules, steps:prepare(), prepare});
  expect(result.answers.r.noul).toBe(0.99);
  expect(states.length).toBeGreaterThan(1);
  expect(states.slice(1).every(state => state.source.length < states[0].source.length)).toBe(true);
});

async function docsFixture(rules, count = 70) {
  const root = await makeGraphFixture(); roots.push(root);
  await mkdir(join(root, 'docs'));
  for (let i = 0; i < count; i++) await writeFile(join(root, 'docs', `${i}.md`), `Document ${i}.`);
  await writeFile(join(root, 'perch.yaml'), rules);
  await commitAll(root, 'docs rules');
  return {root, revision:await revision(root), out:join(root,'.perch'), analyzer:createSourceAnalyzer(), paths:['docs']};
}

it.each([401, 402, 403])('stops file and search scans after one HTTP %i authentication or billing failure', async status => {
  for (const kind of ['ensure', 'ensure_present']) {
    const options = await docsFixture(`- name: a\n  where: docs/*.md\n  ${kind}: Verified documentation.\n- name: b\n  where: docs/*.md\n  ${kind}: Verified examples.\n`);
    let requests = 0;
    const systemOne = createSystemOne({apiKey:'bad', fetchImpl:async () => { requests++; return reply(status,{error:'invalid key'}); }});
    await expect(scanRepository({...options,systemOne})).rejects.toThrow(`HTTP ${status}`);
    expect(requests).toBe(1);
    await expect(systemOne.ask({}, {r:{type:'noul'}})).rejects.toThrow(`HTTP ${status}`);
    expect(requests).toBe(1);
  }
});

it('keeps scheduling limits out of answer cache identities', () => {
  const client = limits => createSystemOne({apiKey:'fixture',limits});
  expect(client({...TOKEN_LIMITS,unitRequests:1}).cacheKey).toBe(client({...TOKEN_LIMITS,unitRequests:64}).cacheKey);
  expect(client({...TOKEN_LIMITS,state:8000}).cacheKey).not.toBe(client(TOKEN_LIMITS).cacheKey);
});

it('reuses completed file checks when only the internal request allowance changes', async () => {
  const options = await docsFixture('- name: docs\n  where: docs/*.md\n  ensure: Verified documentation.\n',2);
  let requests=0;
  const fetchImpl=async (_url,init) => {
    requests++;
    const {questions}=JSON.parse(init.body);
    return reply(200,{answers:Object.fromEntries(Object.keys(questions).map(key=>[key,{noul:0.99}]))});
  };
  for (const unitRequests of [1,64]) {
    const systemOne=createSystemOne({apiKey:'fixture',fetchImpl,limits:{...TOKEN_LIMITS,unitRequests}});
    const run=await scanRepository({...options,systemOne});
    expect(run.status).toBe('complete');
    expect(run.carried).toBe(unitRequests===1 ? 0 : 2);
    expect(requests).toBe(2);
  }
});

it('stops a method scan immediately on an authentication failure', async () => {
  const options=await docsFixture('[]\n',0);
  let requests=0;
  const systemOne=createSystemOne({apiKey:'bad',fetchImpl:async()=>{requests++;return reply(401,{error:'invalid key'});}});
  await expect(scanRepository({...options,paths:['src'],systemOne})).rejects.toThrow('HTTP 401');
  expect(requests).toBe(1);
});

it('does not expose the internal request ceiling as a CLI option', async () => {
  for (const command of ['scan','check']) {
    const output = [];
    expect(await main([command,'--help'], {env:{},stdout:text=>output.push(text),stderr:()=>{}})).toBe(0);
    expect(output.join('\n')).not.toContain('--max-unit-requests');
    expect(await main([command,'--max-unit-requests','10'], {env:{},stdout:()=>{},stderr:()=>{}})).toBe(2);
  }
});

it.each(['ensure_present','ensure_absent'])('retains a %s witness and concurrent failures without caching a clean result', async kind => {
  const options = await docsFixture(`- name: evidence\n  where: docs/*.md\n  ${kind}: Verified documentation.\n`,2);
  const base = scriptedSystemOne();
  let failures = 0;
  const systemOne = {...base, async ask(state, questions) {
    if (!questions.evidence) return base.ask(state,questions);
    if (state.path === 'docs/0.md') { failures++; throw new Error('server unavailable'); }
    return {answers:{evidence:{noul:0.99}}};
  }};
  for (let i=0;i<2;i++) {
    const run = await scanRepository({...options,systemOne,unitParallel:2});
    expect(run.status).toBe('incomplete');
    expect(run.incomplete.join('\n')).toContain('docs/0.md: server unavailable');
    expect(run.broken).toHaveLength(kind === 'ensure_absent' ? 1 : 0);
    if (kind === 'ensure_absent') expect(run.broken[0]).toMatchObject({path:'docs/1.md',key:null});
  }
  expect(failures).toBe(2);
});
