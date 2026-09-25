import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, stat, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginCloud, logoutCloud } from '../src/cloud-auth.js';
import { createCloudClient, configuredSystemOne, remoteRepositoryName } from '../src/cloud-client.js';
import { reportFindings, runContext } from '../src/cloud-results.js';
import { createMeter, metered } from '../src/meter.js';
const response = data => new Response(JSON.stringify(data));
describe('Perch Cloud', () => {
  it('uses the standard client protocol with cloud repository scope and provider metering', async () => {
    const requests = [], client = createCloudClient({origin:'https://example.com',getToken:async()=> 'perch_ci_test',identity:'ci',organizationId:'org',repositoryId:'repo',fetchImpl:async(url,options)=>{
      requests.push({url,body:JSON.parse(options.body)});return response({model:'jev-latest',answers:{a:{noul:.9}},usage:null});
    }});
    const meter=createMeter();await metered(client,meter).ask({code:'a'},{a:{type:'noul',criteria:{true:'yes',false:'no'}}});
    expect(requests).toHaveLength(1);expect(requests[0].url).toBe('https://example.com/v1/systemone');expect(requests[0].body.organizationId).toBe('org');expect(requests[0].body.repositoryId).toBe('repo');expect(meter.total()).toBe(0);
  });
  it('keeps GitLab subgroups and does not invent a repository for an unrecognized remote', () => {
    expect(remoteRepositoryName('git@gitlab.com:group/sub/repo.git')).toBe('group/sub/repo');
    expect(remoteRepositoryName('https://gitlab.com/group/sub/repo.git')).toBe('group/sub/repo');
    expect(remoteRepositoryName('git@github.com:lakeday-org/perch.git')).toBe('lakeday-org/perch');
    expect(remoteRepositoryName('/some/local/project')).toBeNull();
    expect(remoteRepositoryName('https://gitlab.com/group/bad name.git')).toBeNull();
  });
  it('uses a saved login without registering a made-up local repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch loose project '));
    try {
      await mkdir(join(root, '.perch'));
      const accessToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.sig`;
      await writeFile(join(root, '.perch', 'cloud.json'), JSON.stringify({ origin: 'https://dash.perchscan.com', organizationId: 'org', accessToken }));
      const requests = [];
      const client = await configuredSystemOne({ env: { HOME: root }, root, fetchImpl: async (url, options = {}) => {
        requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
        return response(url.endsWith('/api/config') ? { model: 'jev-latest', epoch: '1' } : { model: 'jev-latest', answers: { a: { noul: 0.9 } }, usage: null });
      } });
      expect(client.report).toBeUndefined();
      await client.ask({ code: 'a' }, { a: { type: 'noul', criteria: { true: 'yes', false: 'no' } } });
      expect(requests.map(request => new URL(request.url).pathname)).toEqual(['/api/config', '/v1/systemone']);
      expect(requests.at(-1).body.repositoryId).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('serializes concurrent refreshes of the same rotating credential',async()=>{
    const root=await mkdtemp(join(tmpdir(),'perch-refresh-'));
    try {
      await mkdir(join(root,'.perch'));
      await writeFile(join(root,'.perch','cloud.json'),JSON.stringify({origin:'https://dash.perchscan.com',clientId:'client',organizationId:'org',accessToken:'expired',refreshToken:'refresh'}));
      let refreshes=0;
      const accessToken=`header.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+300})).toString('base64url')}.sig`;
      const fetchImpl=async url=>{
        if(url.endsWith('/authenticate')){refreshes++; await new Promise(resolve=>setTimeout(resolve,20)); return response({access_token:accessToken,refresh_token:'rotated'});}
        return response({model:'jev',epoch:'1'});
      };
      const options={env:{HOME:root,PERCH_REPOSITORY:'repo'},root,fetchImpl};
      await Promise.all([configuredSystemOne(options),configuredSystemOne(options)]);
      expect(refreshes).toBe(1);
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it('CI credentials use the gateway without requesting a provider key',async()=>{
    const root=await mkdtemp(join(tmpdir(),'perch-cloud-'));
    try {
      const requests=[];
      const client=await configuredSystemOne({env:{HOME:root,PERCH_TOKEN:'perch_ci_test'},root,fetchImpl:async(url,options)=>{
        requests.push({url,options});return response(url.endsWith('/config')?{model:'jev-1',epoch:'2'}:{answers:{a:{noul:1}}});
      }});
      await client.ask({code:'a'},{a:{}}); expect(requests.at(-1).url).toBe('https://dash.perchscan.com/v1/systemone');
      expect(requests.at(-1).options.headers.authorization).toBe('Bearer perch_ci_test');
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it('device login stores private credentials and never prints the device or refresh secret',async()=>{
    const root=await mkdtemp(join(tmpdir(),'perch-login-')), output=[];
    try {
      const fetchImpl=async(url)=>response(url.endsWith('/config')?{clientId:'client_test'}:url.endsWith('/device')?{device_code:'private-device',user_code:'ABCD-EFGH',verification_uri:'https://auth.test/device',expires_in:300,interval:5}:url.endsWith('/authenticate')?{access_token:'private-access',refresh_token:'private-refresh'}:{organizations:[{id:'org',name:'Team'}]});
      await loginCloud({env:{HOME:root},stdout:line=>output.push(line),fetchImpl,sleep:async()=>{}});
      const file=join(root,'.perch','cloud.json'); expect((await stat(file)).mode&0o777).toBe(0o600);
      expect(JSON.parse(await readFile(file,'utf8')).organizationId).toBe('org');
      expect(output.join('\n')).not.toContain('private-'); expect(output.join('\n')).toContain('ABCD-EFGH');
      await logoutCloud({env:{HOME:root},stdout:()=>{}}); await expect(readFile(file)).rejects.toThrow();
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it('signs in a GitHub Actions job with its OIDC token, fresh on each request, and names no repository of its own', async () => {
    const seen = [];
    let issued = 0;
    const fetchImpl = async (url, options = {}) => {
      const href = String(url);
      if (href.startsWith('https://actions.example/token')) { expect(new URL(href).searchParams.get('audience')).toBe('https://dash.perchscan.com'); issued++; return response({ value: `oidc-${issued}` }); }
      if (href.endsWith('/api/config')) return response({ model: 'jev-latest', epoch: '1' });
      seen.push({ url: href, auth: options.headers.authorization, body: JSON.parse(options.body) });
      return response(href.endsWith('/v1/scans') ? { id: 'scan', url: 'https://dash.perchscan.com/?scan=scan' } : { model: 'jev', answers: { a: { noul: 0.1 } }, usage: null });
    };
    const env = { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example/token?x=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime', HOME: '/nonexistent' };
    const client = await configuredSystemOne({ env, root: process.cwd(), fetchImpl });
    await client.ask({ code: 'a' }, { a: { type: 'noul', criteria: { true: 'y', false: 'n' } } });
    expect((await client.report({ scan: { scope: 'full' }, findings: [] })).url).toContain('scan=scan');
    expect(seen.map(r => r.auth)).toEqual(['Bearer oidc-1', 'Bearer oidc-1']);
    expect(seen[0].body.repositoryId).toBeUndefined();
    expect(seen[1].url).toBe('https://dash.perchscan.com/v1/scans');
  });
  it('an explicit key still wins over the Actions token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-key-'));
    try {
      await mkdir(join(root, '.perch'));
      await writeFile(join(root, '.perch', 'cloud.json'), JSON.stringify({ origin: 'https://cloud.example.com', accessToken: 'saved' }));
      const env = { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime',
        PERCH_API_KEY: 'key', HOME: root };
      expect((await configuredSystemOne({ env, root, fetchImpl: async () => { throw new Error('no request expected'); } })).report).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('names a pull request by its head commit, not the merge commit the job checked out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-event-'));
    try {
      await writeFile(join(root, 'event.json'), JSON.stringify({ pull_request: { number: 12, head: { sha: 'feedface' } } }));
      expect(await runContext({ CI: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: join(root, 'event.json'), GITHUB_HEAD_REF: 'fix' }, 'mergecommit'))
        .toEqual({ source: 'ci', revision: 'feedface', branch: 'fix', pull_request: 12 });
      expect(await runContext({}, 'abc1234', 'main')).toEqual({ source: 'cli', revision: 'abc1234', branch: 'main', pull_request: null });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('reports each issue a finding shows, with severity only on defects and vulnerabilities', () => {
    const finding = { id: 'f1', path: 'src/a.js', name: 'go', line: 3, has_bug: 0.9, kind: { choice: 'wrong_return', probability: 0.8, probabilities: { wrong_return: 0.8 } },
      severity: { probabilities: { 0: 0, 1: 0, 2: 0.1, 3: 0.9 } }, does_what_it_claims: 0.9, exposed: 0.1 };
    const rows = reportFindings([finding], 0.5);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['id', 'kind', 'line', 'method', 'path', 'probability', 'severity', 'type']);
      expect(row.method).toBe('src/a.js::go');
      if (!['defect', 'security'].includes(row.type)) expect(row.severity).toBeNull();
    }
  });
});
