import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../src/git.js';
import { serveMcp } from '../src/mcp.js';
import { initRepo } from './helpers.js';

const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'perch-mcp-'));
  cleanups.push(root);
  await writeFile(join(root, 'a.js'), 'export const a = 1;\n');
  await initRepo(root);
  await git(['remote', 'add', 'origin', 'git@github.com:acme/web.git'], root);
  return root;
}

const scan = { id: 'scan-1', url: 'https://dash.perchscan.com/#/scan/scan-1', pull_request: 318, branch: 'work', revision: 'a1b2c3d4',
  scope: 'partial', finished_at: 0, exit_code: 3, open_issues: 1, security: 0, defect: 1, lint: 0, refactor: 0, docs: 0, methods: 38 };

/** The Cloud, as far as these two endpoints go, recording what it was asked. */
function cloud() {
  const asked = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    asked.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), authorization: options.headers.authorization });
    if (parsed.pathname === '/v1/scans/recent') return Response.json({ scans: [scan], nextCursor: null });
    if (parsed.pathname === '/v1/scans/detail' && parsed.searchParams.get('scanId') === 'scan-1') return Response.json({ scan, url: scan.url,
      findings: [{ id: 'f1', path: 'src/session.js', method: 'src/session.js::refresh', line: 42, type: 'defect', kind: 'swallowed_error', probability: 0.81, severity: 'P1' }] });
    return Response.json({ error: 'Scan not found.' }, { status: 404 });
  };
  return { asked, fetchImpl };
}

/** Starts the server on in-memory streams and sends it messages, one per line, collecting its answers by id. */
function connect({ env, root, fetchImpl }) {
  const input = new PassThrough(), output = new PassThrough();
  const answers = new Map(), waiting = new Map();
  let buffered = '';
  output.on('data', chunk => {
    buffered += chunk;
    for (let end; (end = buffered.indexOf('\n')) >= 0; buffered = buffered.slice(end + 1)) {
      const message = JSON.parse(buffered.slice(0, end));
      answers.set(message.id, message); waiting.get(message.id)?.(message);
    }
  });
  const done = serveMcp({ env, root, version: 'test', input, output, fetchImpl });
  let next = 1;
  const request = (method, params) => {
    const id = next++;
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return answers.has(id) ? Promise.resolve(answers.get(id)) : new Promise(resolve => waiting.set(id, resolve));
  };
  const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
  return { request, call, notify: method => input.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`), close: () => { input.end(); return done; } };
}

describe('perch mcp', () => {
  it('starts as an MCP server and lists the two scan tools', async () => {
    const server = connect({ env: { PERCH_API_KEY: 'ci' }, root: await repository(), fetchImpl: cloud().fetchImpl });
    const init = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'perch' } });
    server.notify('notifications/initialized');
    expect((await server.request('tools/list')).result.tools.map(tool => tool.name)).toEqual(['perch_scans', 'perch_scan']);
    expect((await server.request('nope')).error.code).toBe(-32601);
    await server.close();
  });

  it('lists the checked-out branch\'s CI scans for the repository the git remote names, signed in with perch login', async () => {
    const root = await repository(), home = await mkdtemp(join(tmpdir(), 'perch-home-'));
    cleanups.push(home);
    await mkdir(join(home, '.perch'));
    await writeFile(join(home, '.perch', 'cloud.json'), JSON.stringify({ origin: 'https://dash.perchscan.com', kind: 'perch',
      accessToken: 'login-token', expiresAt: Date.now() + 3600_000, organizationId: 'org_1' }));
    const { asked, fetchImpl } = cloud();
    const server = connect({ env: { HOME: home }, root, fetchImpl });
    const listed = JSON.parse((await server.call('perch_scans', {})).content[0].text);
    expect(asked[0]).toEqual({ path: '/v1/scans/recent', authorization: 'Bearer login-token',
      query: { repository: 'acme/web', branch: 'work', organizationId: 'org_1' } });
    // What the Cloud stores is reworded for a reader: a revision is a commit, a partial scope is the changes, exit 3 is issues.
    expect(listed).toEqual({ repository: 'acme/web', branch: 'work', pull_request: null, scans: [{ id: 'scan-1', url: scan.url,
      pull_request: 318, branch: 'work', commit: 'a1b2c3d4', scope: 'changes only', finished_at: '1970-01-01T00:00:00.000Z',
      result: 'issues', issues: 1, security: 0, defect: 1, lint: 0, refactor: 0, docs: 0, methods: 38 }] });
    await server.call('perch_scans', { all_branches: true });
    expect(asked[1].query).not.toHaveProperty('branch');
    await server.close();
  });

  it('gives one scan\'s issues with the perch check command for each, and a Cloud refusal as a tool error', async () => {
    const server = connect({ env: { PERCH_API_KEY: 'ci' }, root: await repository(), fetchImpl: cloud().fetchImpl });
    const found = JSON.parse((await server.call('perch_scan', { scan_id: 'scan-1' })).content[0].text);
    expect(found.issues).toEqual([expect.objectContaining({ method: 'src/session.js::refresh', line: 42, kind: 'swallowed_error',
      check: 'perch check src/session.js::refresh' })]);
    const missing = await server.call('perch_scan', { scan_id: 'other' });
    expect(missing).toEqual({ content: [{ type: 'text', text: 'Scan not found.' }], isError: true });
    await server.close();
  });

  it('says to run perch login when there is no way to sign in', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-home-'));
    cleanups.push(home);
    const server = connect({ env: { HOME: home }, root: await repository(), fetchImpl: cloud().fetchImpl });
    const result = await server.call('perch_scans', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/perch login/);
    await server.close();
  });
});
