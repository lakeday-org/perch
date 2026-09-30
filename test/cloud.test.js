import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionsToken, loginCloud, logoutCloud } from '../src/cloud-auth.js';
import { createCloudClient, configuredSystemOne, remoteRepositoryName } from '../src/cloud-client.js';
import { git } from '../src/git.js';
import { main } from '../src/cli.js';
import { createResultStream, reportFindings, runContext } from '../src/cloud-results.js';
import { createMeter, metered } from '../src/meter.js';
const response = data => new Response(JSON.stringify(data));

describe('Perch Cloud', () => {
  it('uses the standard client protocol with cloud repository scope and provider metering', async () => {
    const requests = [];
    const client = createCloudClient({
      origin: 'https://example.com',
      getToken: async () => 'perch_ci_test',
      organizationId: 'org', repositoryId: 'repo', reports: true,
      fetchImpl: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return response({ model: 'jev-latest', answers: { a: { noul: 0.9 } }, usage: null });
      },
    });
    const meter = createMeter();
    await metered(client, meter).ask({ code: 'a' }, { a: { type: 'noul', criteria: { true: 'yes', false: 'no' } } });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://example.com/v1/systemone');
    expect(requests[0].body).toMatchObject({ organizationId: 'org', repositoryId: 'repo' });
    expect(meter.total()).toBe(0);
  });

  it('asks the Cloud to skip its cached answers only when forced', async () => {
    const bodies = [];
    const client = force => createCloudClient({
      origin: 'https://example.com', getToken: async () => 'perch_ci_test', organizationId: 'org', repositoryId: 'repo', force,
      fetchImpl: async (url, options) => { bodies.push(JSON.parse(options.body)); return response({ model: 'd1:free', answers: { a: { noul: 0.9 } }, usage: null }); },
    });
    await client(true).ask({ code: 'a' }, { a: { type: 'noul' } });
    await client(false).ask({ code: 'a' }, { a: { type: 'noul' } });
    expect(bodies[0].force).toBe(true);
    expect('force' in bodies[1]).toBe(false);
  });
  it('uses the Cloud charge for cost even when the provider used no tokens', async () => {
    const client = createCloudClient({
      origin: 'https://example.com', getToken: async () => 'token', organizationId: 'org', repositoryId: null,
      fetchImpl: async () => response({ model: 'jev-latest', answers: { a: { noul: 0.9 } }, usage: null, charge: { totalNanos: 100000 } }),
    });
    const meter = createMeter();
    await metered(client, meter).ask({ code: 'a' }, { a: { type: 'noul', criteria: { true: 'yes', false: 'no' } } });
    expect(meter.total()).toBe(0.0001);
    expect(meter.lines()[0]).toContain('$0.0001');
    expect(meter.toJSON()['jev-latest'].cost).toBe(0.0001);
  });
  it('keeps GitLab subgroups and does not invent a repository for an unrecognized remote', () => {
    expect(remoteRepositoryName('git@gitlab.com:group/sub/repo.git')).toBe('group/sub/repo');
    expect(remoteRepositoryName('https://gitlab.com/group/sub/repo.git')).toBe('group/sub/repo');
    expect(remoteRepositoryName('git@github.com:lakeday-org/perch.git')).toBe('lakeday-org/perch');
    expect(remoteRepositoryName('/some/local/project')).toBeNull();
    expect(remoteRepositoryName('https://gitlab.com/group/bad name.git')).toBeNull();
  });
  it('uses a saved login in a Git repository without a remote', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch unlinked repo '));
    try {
      await git(['init', '-q'], root);
      await git(['config', 'user.name', 'Fixture'], root);
      await git(['config', 'user.email', 'fixture@example.com'], root);
      await writeFile(join(root, 'app.js'), 'export function app() { return 1; }\n');
      await git(['add', 'app.js'], root);
      await git(['commit', '-q', '-m', 'fixture'], root);
      await mkdir(join(root, '.perch'));
      await writeFile(join(root, '.perch', 'cloud.json'), JSON.stringify({
        kind: 'perch', origin: 'https://dash.perchscan.com', organizationId: 'org', accessToken: 'perch_cli_test', expiresAt: Date.now() + 300000,
      }));
      const requests = [];
      const client = await configuredSystemOne({ env: { HOME: root }, root, fetchImpl: async (url, options = {}) => {
        requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
        if (url.endsWith('/api/config')) return response({ model: 'jev-latest', epoch: '1' });
        return response({ model: 'jev-latest', answers: { a: { noul: 0.9 } }, usage: null });
      } });
      expect(client.report).toBeUndefined();
      await client.ask({ code: 'a' }, { a: { type: 'noul', criteria: { true: 'yes', false: 'no' } } });
      expect(requests.map(request => new URL(request.url).pathname)).toEqual(['/api/config', '/v1/systemone']);
      expect(requests.at(-1).body.repositoryId).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('serializes concurrent refreshes of the same rotating credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-refresh-'));
    try {
      await mkdir(join(root, '.perch'));
      await writeFile(join(root, '.perch', 'cloud.json'), JSON.stringify({
        kind: 'perch', origin: 'https://dash.perchscan.com', organizationId: 'org', accessToken: 'expired', refreshToken: 'refresh', expiresAt: 0,
      }));
      let refreshes = 0;
      const accessToken = 'perch_cli_rotated';
      const fetchImpl = async url => {
        if (url.endsWith('/auth/device/refresh')) {
          refreshes++;
          await new Promise(resolve => setTimeout(resolve, 20));
          return response({ access_token: accessToken, refresh_token: 'rotated', expires_at: Date.now() + 900000 });
        }
        return response({ model: 'jev', epoch: '1' });
      };
      const options = { env: { HOME: root, PERCH_REPOSITORY: 'repo' }, root, fetchImpl };
      await Promise.all([configuredSystemOne(options), configuredSystemOne(options)]);
      expect(refreshes).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('a PERCH_API_KEY with no PERCH_BASE_URL is a Perch Cloud CI token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-cloud-'));
    try {
      const requests = [];
      const client = await configuredSystemOne({
        env: { HOME: root, PERCH_API_KEY: 'perch_ci_test' }, root,
        fetchImpl: async (url, options) => {
          requests.push({ url, options });
          return response(url.endsWith('/config') ? { model: 'jev-1', epoch: '2' } : { answers: { a: { noul: 1 } } });
        },
      });
      await client.ask({ code: 'a' }, { a: {} });
      expect(requests.at(-1).url).toBe('https://dash.perchscan.com/v1/systemone');
      expect(requests.at(-1).options.headers.authorization).toBe('Bearer perch_ci_test');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('device login stores private credentials and never prints the device or refresh secret', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-login-'));
    const output = [];
    const requests = [];
    try {
      const fetchImpl = async url => {
        requests.push(url);
        if (url.endsWith('/auth/device/start')) return response({
          device_code: 'private-device', user_code: 'ABCD-EFGH',
          verification_uri: 'https://dash.perchscan.com/device', expires_in: 300, interval: 5,
        });
        if (url.endsWith('/auth/device/token')) return response({ access_token: 'private-access', refresh_token: 'private-refresh', expires_at: Date.now() + 900000 });
        return response({ organizations: [{ id: 'org', name: 'Team' }] });
      };
      await loginCloud({ env: { HOME: root }, stdout: line => output.push(line), fetchImpl, sleep: async () => {} });
      const file = join(root, '.perch', 'cloud.json');
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(file, 'utf8')).organizationId).toBe('org');
      expect(output.join('\n')).not.toContain('private-');
      expect(output.join('\n')).toContain('ABCD-EFGH');
      await logoutCloud({ env: { HOME: root }, stdout: () => {}, fetchImpl });
      expect(requests.every(url => url.startsWith('https://dash.perchscan.com/'))).toBe(true);
      await expect(readFile(file)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('doctor reports a corrupt saved login and logout can remove it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-corrupt-login-'));
    try {
      await mkdir(join(root, '.perch'));
      await writeFile(join(root, '.perch', 'cloud.json'), '{bad json');
      const output = [];
      const io = { env: { HOME: root }, stdout: text => output.push(text), stderr: () => {} };
      expect(await main(['doctor', '--json', '--out', join(root, '.perch')], io)).toBe(1);
      expect(JSON.parse(output.at(-1)).checks).toContainEqual(expect.objectContaining({ name: 'login', ok: false }));
      expect(await main(['logout'], io)).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('logout removes the saved login when revocation is already invalid or the Cloud is offline', async () => {
    for (const [name, fetchImpl, warns] of [
      ['revoked', async () => new Response(JSON.stringify({ error: 'Invalid refresh token' }), { status: 401 }), false],
      ['offline', async () => { throw new Error('Network unavailable'); }, true],
    ]) {
      const root = await mkdtemp(join(tmpdir(), `perch-logout-${name}-`));
      const file = join(root, '.perch', 'cloud.json');
      const output = [], errors = [];
      try {
        await mkdir(join(root, '.perch'));
        await writeFile(file, JSON.stringify({ kind: 'perch', refreshToken: 'expired-token' }));
        await logoutCloud({ env: { HOME: root }, stdout: line => output.push(line), stderr: line => errors.push(line), fetchImpl });
        await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(output.join(' ')).toContain('Removed this device');
        expect(errors.length > 0).toBe(warns);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });
  it('rejects incomplete device authorization responses before showing a code', async () => {
    const output = [];
    const fetchImpl = async () => response({ user_code: 'ABCD-EFGH' });
    await expect(loginCloud({ env: {}, stdout: text => output.push(text), fetchImpl })).rejects.toThrow('invalid device code');
    expect(output).toEqual([]);
  });
  it('rejects malformed sign-in and organization responses without saving them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-bad-login-'));
    const device = {
      device_code: 'device', user_code: 'ABCD-EFGH', verification_uri: 'https://dash.perchscan.com/device', expires_in: 300, interval: 5,
    };
    try {
      for (const [reply, message] of [[{ access_token: 42, refresh_token: 'refresh' }, 'invalid credentials'],
        [{ access_token: 'access', refresh_token: 'refresh' }, 'invalid organization list']]) {
        const fetchImpl = async url => {
          if (url.endsWith('/auth/device/start')) return response(device);
          if (url.endsWith('/auth/device/token')) return response({ ...reply, expires_at: Date.now() + 900000 });
          return response({ organizations: null });
        };
        await expect(loginCloud({ env: { HOME: root }, stdout: () => {}, fetchImpl, sleep: async () => {} })).rejects.toThrow(message);
      }
      await expect(readFile(join(root, '.perch', 'cloud.json'))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('signs in a GitHub Actions job with its OIDC token, fresh on each request, and names no repository of its own', async () => {
    const seen = [];
    let issued = 0;
    const fetchImpl = async (url, options = {}) => {
      const href = String(url);
      if (href.startsWith('https://actions.example/token')) {
        expect(new URL(href).searchParams.get('audience')).toBe('https://dash.perchscan.com');
        issued++;
        return response({ value: `oidc-${issued}` });
      }
      if (href.endsWith('/api/config')) return response({ model: 'jev-latest', epoch: '1' });
      seen.push({ url: href, auth: options.headers.authorization, body: JSON.parse(options.body) });
      if (href.includes('/v1/scans/')) return response({ id: 'scan', url: 'https://dash.perchscan.com/?scan=scan' });
      return response({ model: 'jev', answers: { a: { noul: 0.1 } }, usage: null });
    };
    const env = {
      GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example/token?x=1',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime', HOME: '/nonexistent',
    };
    const client = await configuredSystemOne({ env, root: process.cwd(), fetchImpl });
    await client.ask({ code: 'a' }, { a: { type: 'noul', criteria: { true: 'y', false: 'n' } } });
    const started = await client.startScan({ scope: 'full' });
    await client.appendFindings(started.id, [{ id: 'one', kind: 'defect' }]);
    await client.updateScan(started.id, { phase: 'reading', completed: 1, total: 2, failed: 0 });
    expect((await client.finishScan(started.id, { exit_code: 3 })).url).toContain('scan=scan');
    expect(seen.map(r => r.auth)).toEqual(Array(5).fill('Bearer oidc-1'));
    expect(seen[0].body.repositoryId).toBeUndefined();
    expect(seen.slice(1).map(r => r.url)).toEqual(['start', 'append', 'progress', 'finish'].map(path => `https://dash.perchscan.com/v1/scans/${path}`));
  });
  it('says to sign in when there is no login, key or Actions token, before sending anything', async () => {
    await expect(configuredSystemOne({ env: { HOME: '/nonexistent' }, root: process.cwd(), fetchImpl: async () => { throw new Error('unexpected request'); } }))
      .rejects.toThrow('Run perch login, or set PERCH_API_KEY');
  });
  it('bounds each result request while waiting for an Actions token', async () => {
    const env = {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime',
    };
    const requests = [];
    const fetchImpl = (url, options) => {
      requests.push(String(url));
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    };
    const client = createCloudClient({
      origin: 'https://dash.perchscan.com', organizationId: 'org', repositoryId: null, reports: true,
      getToken: actionsToken(env, 'https://dash.perchscan.com', fetchImpl), fetchImpl, reportTimeoutMs: 20,
    });

    await expect(client.startScan({ scope: 'full' })).rejects.toThrow();
    expect(requests).toEqual(['https://actions.example/token?audience=https%3A%2F%2Fdash.perchscan.com']);
  });
  it('PERCH_BASE_URL is the one setting that sends questions somewhere other than Perch Cloud', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-key-'));
    try {
      await mkdir(join(root, '.perch'));
      await writeFile(join(root, '.perch', 'cloud.json'), JSON.stringify({ origin: 'https://dash.perchscan.com', accessToken: 'saved' }));
      const env = {
        GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime',
        PERCH_API_KEY: 'key', PERCH_BASE_URL: 'https://api.example.com/v1/systemone', HOME: root,
      };
      const requests = [];
      const client = await configuredSystemOne({ env, root, fetchImpl: async (url, options) => {
        requests.push({ url: String(url), auth: options.headers.authorization });
        return response({ model: 'jev-latest', answers: { a: { noul: 0.9 } }, usage: null });
      } });
      await client.ask({ code: 'a' }, { a: { type: 'noul', criteria: { true: 'yes', false: 'no' } } });
      expect(requests).toEqual([{ url: 'https://api.example.com/v1/systemone', auth: 'Bearer key' }]);
      expect(client.report).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('names a pull request by its head commit, not the merge commit the job checked out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-event-'));
    try {
      await writeFile(join(root, 'event.json'), JSON.stringify({ pull_request: { number: 12, head: { sha: 'feedface' } } }));
      const env = { CI: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: join(root, 'event.json'), GITHUB_HEAD_REF: 'fix' };
      expect(await runContext(env, 'mergecommit'))
        .toEqual({ source: 'ci', revision: 'feedface', branch: 'fix', pull_request: 12 });
      expect(await runContext({}, 'abc1234', 'main')).toEqual({ source: 'cli', revision: 'abc1234', branch: 'main', pull_request: null });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('reports each issue a finding shows, with severity only on defects and vulnerabilities', () => {
    const finding = { id: 'f1', path: 'src/a.js', name: 'go', line: 3, has_bug: 0.9,
      kind: { choice: 'wrong_return', probability: 0.8, probabilities: { wrong_return: 0.8 } },
      severity: { probabilities: { 0: 0, 1: 0, 2: 0.1, 3: 0.9 } }, does_what_it_claims: 0.9, exposed: 0.1 };
    const rows = reportFindings([finding], 0.5);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['id', 'kind', 'line', 'method', 'path', 'probability', 'severity', 'type']);
      expect(row.method).toBe('src/a.js::go');
      if (!['defect', 'security'].includes(row.type)) expect(row.severity).toBeNull();
    }
  });
  it('sends results before a scan ends without dropping those past 2,000', async () => {
    const batches = [];
    const progress = [];
    let finished = false;
    const client = {
      startScan: async () => ({ id: 'scan' }),
      appendFindings: async (_id, rows) => { batches.push(rows); },
      updateScan: async (_id, value) => { progress.push(value); },
      finishScan: async () => { finished = true; return { url: 'https://dash.perchscan.com/?scan=scan' }; },
    };
    const stream = createResultStream(client, { scope: 'full' });
    stream.progress({ phase: 'reading', completed: 5, total: 20, failed: 0 });
    stream.progress({ phase: 'reading', completed: 8, total: 20, failed: 0 });
    const rows = Array.from({ length: 2001 }, (_, n) => ({ id: String(n), kind: 'defect', path: 'src/a.js' }));
    stream.add(rows);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(batches.length).toBeGreaterThan(0);
    expect(finished).toBe(false);
    stream.add(rows.slice(0, 10));
    await stream.finish({ exit_code: 3 });
    expect(batches.flat()).toHaveLength(2001);
    expect(progress).toEqual([{ phase: 'reading', completed: 8, total: 20, failed: 0 }]);
    expect(finished).toBe(true);
  });
  it('keeps only the latest progress while an earlier update is in flight', async () => {
    let release;
    const firstUpdate = new Promise(resolve => { release = resolve; });
    const updates = [];
    const client = {
      startScan: async () => ({ id: 'scan' }),
      appendFindings: async () => {},
      updateScan: async (_id, value) => {
        updates.push(value.completed);
        if (updates.length === 1) await firstUpdate;
      },
      finishScan: async () => ({ id: 'scan' }),
    };
    const stream = createResultStream(client, { scope: 'partial' });
    stream.progress({ phase: 'reading', completed: 1, total: 3, failed: 0 });
    await new Promise(resolve => setTimeout(resolve, 800));
    stream.progress({ phase: 'reading', completed: 2, total: 3, failed: 0 });
    stream.progress({ phase: 'reading', completed: 3, total: 3, failed: 0 });
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(updates).toEqual([1]);
    release();
    await stream.finish({ exit_code: 0 });
    expect(updates).toEqual([1, 3]);
  });
  it('settles a failed result upload without leaving the scan waiting', async () => {
    const started = createResultStream({
      startScan: async () => { throw new Error('start failed'); },
      appendFindings: async () => {},
    }, { scope: 'partial' });
    started.add([{ id: 'one', kind: 'defect' }]);
    await expect(started.finish({ exit_code: 1 })).rejects.toThrow('start failed');

    const appended = createResultStream({
      startScan: async () => ({ id: 'scan' }),
      appendFindings: async () => { throw new Error('append failed'); },
    }, { scope: 'partial' });
    appended.add([{ id: 'one', kind: 'defect' }]);
    await expect(appended.finish({ exit_code: 1 })).rejects.toThrow('append failed');
  });
});
