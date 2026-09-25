import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, stat, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudClient, configuredSystemOne, loginCloud, logoutCloud } from '../src/cloud.js';
import { createMeter, metered } from '../src/meter.js';
const response = data => new Response(JSON.stringify(data));
describe('Perch Cloud', () => {
  it('uses the standard client protocol with cloud repository scope and provider metering', async () => {
    const requests = [], client = createCloudClient({origin:'https://example.com',token:'perch_ci_test',organizationId:'org',repositoryId:'repo',fetchImpl:async(url,options)=>{
      requests.push({url,body:JSON.parse(options.body)});return response({model:'jev-latest',answers:{a:{noul:.9}},usage:null});
    }});
    const meter=createMeter();await metered(client,meter).ask({code:'a'},{a:{type:'noul',criteria:{true:'yes',false:'no'}}});
    expect(requests).toHaveLength(1);expect(requests[0].url).toBe('https://example.com/v1/systemone');expect(requests[0].body.organizationId).toBe('org');expect(requests[0].body.repositoryId).toBe('repo');expect(meter.total()).toBe(0);
  });
  it('isolates local answer identity by tenant, repo, model epoch and gateway',()=>{
    const base={origin:'https://example.com',token:'x',organizationId:'one',repositoryId:'repo',epoch:'1'};
    for(const change of [{organizationId:'two'},{repositoryId:'other'},{epoch:'2'},{origin:'https://elsewhere.com'}]) expect(createCloudClient({...base,...change}).cacheKey).not.toBe(createCloudClient(base).cacheKey);
  });
  it('keeps user cache identity through token refresh but separates CI credentials',()=>{
    const base={origin:'https://example.com',organizationId:'one',repositoryId:'repo'};
    expect(createCloudClient({...base,token:'old-jwt'}).cacheKey).toBe(createCloudClient({...base,token:'new-jwt'}).cacheKey);
    expect(createCloudClient({...base,token:'perch_ci_a'}).cacheKey).not.toBe(createCloudClient({...base,token:'perch_ci_b'}).cacheKey);
  });
  it('serializes concurrent refreshes of the same rotating credential',async()=>{
    const root=await mkdtemp(join(tmpdir(),'perch-refresh-'));
    try {
      await mkdir(join(root,'perch'));
      await writeFile(join(root,'perch','cloud.json'),JSON.stringify({origin:'https://dash.perchscan.com',clientId:'client',organizationId:'org',accessToken:'expired',refreshToken:'refresh'}));
      let refreshes=0;
      const accessToken=`header.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+300})).toString('base64url')}.sig`;
      const fetchImpl=async url=>{
        if(url.endsWith('/authenticate')){refreshes++; await new Promise(resolve=>setTimeout(resolve,20)); return response({access_token:accessToken,refresh_token:'rotated'});}
        return response({model:'jev',epoch:'1'});
      };
      const options={env:{XDG_CONFIG_HOME:root,PERCH_REPOSITORY:'repo'},root,fetchImpl};
      await Promise.all([configuredSystemOne(options),configuredSystemOne(options)]);
      expect(refreshes).toBe(1);
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it('CI credentials use the gateway without requesting a provider key',async()=>{
    const root=await mkdtemp(join(tmpdir(),'perch-cloud-'));
    try {
      const requests=[];
      const client=await configuredSystemOne({env:{XDG_CONFIG_HOME:root,PERCH_TOKEN:'perch_ci_test'},root,fetchImpl:async(url,options)=>{
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
      await loginCloud({env:{XDG_CONFIG_HOME:root},stdout:line=>output.push(line),fetchImpl,sleep:async()=>{}});
      const file=join(root,'perch','cloud.json'); expect((await stat(file)).mode&0o777).toBe(0o600);
      expect(JSON.parse(await readFile(file,'utf8')).organizationId).toBe('org');
      expect(output.join('\n')).not.toContain('private-'); expect(output.join('\n')).toContain('ABCD-EFGH');
      await logoutCloud({env:{XDG_CONFIG_HOME:root},stdout:()=>{}}); await expect(readFile(file)).rejects.toThrow();
    } finally {await rm(root,{recursive:true,force:true});}
  });
});
