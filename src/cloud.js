/** Perch Cloud device login and repository-scoped inference. Credentials stay outside the repository. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { git } from './git.js';
import { createSystemOne } from './systemone.js';

export const CLOUD_ORIGIN = 'https://dash.perchscan.com';
const hash = value => createHash('sha256').update(value).digest('hex');
const credentialPath = env => join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'perch', 'cloud.json');
const cloudOrigin = env => {
  const url = new URL(env.PERCH_CLOUD_URL || CLOUD_ORIGIN);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('PERCH_CLOUD_URL must use HTTPS.');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PERCH_CLOUD_URL must be an origin without credentials or a path.');
  return url.origin;
};
async function readCredentials(env) {
  try { return JSON.parse(await readFile(credentialPath(env), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Could not read Perch login. Run perch logout, then perch login.', { cause: error }); }
}
async function saveCredentials(env, credentials) {
  const path = credentialPath(env); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(credentials) + '\n', { mode: 0o600 }); await rename(temporary, path);
}
async function request(fetchImpl, url, options) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(150000) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error_description || data.error || `Cloud request failed (${response.status})`), { status: response.status });
  return data;
}
const form = input => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(input) });
const post = (token, input) => ({ method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });

export async function loginCloud({ env, organization, stdout, fetchImpl = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const origin = cloudOrigin(env), config = await request(fetchImpl, `${origin}/api/config`);
  if (!config.clientId) throw new Error('Perch Cloud sign-in is not configured yet.');
  const device = await request(fetchImpl, 'https://api.workos.com/user_management/authorize/device', form({ client_id: config.clientId }));
  stdout(`Open ${device.verification_uri}\nEnter code: ${device.user_code}`);
  const deadline = Date.now() + Math.min(device.expires_in, 600) * 1000;
  let interval = Math.max(5, device.interval || 5), result;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const response = await fetchImpl('https://api.workos.com/user_management/authenticate', { ...form({ client_id: config.clientId,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code }), signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (response.ok) { result = data; break; }
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { interval += 5; continue; }
    throw new Error('Sign-in was denied or expired. Run perch login again.');
  }
  if (!result?.access_token || !result.refresh_token) throw new Error('Sign-in timed out. Run perch login again.');
  const user = await request(fetchImpl, `${origin}/api/me`, { headers: { authorization: `Bearer ${result.access_token}` } });
  const selected = user.organizations.find(org => org.id === (organization || env.PERCH_ORGANIZATION)) || (!organization && !env.PERCH_ORGANIZATION && user.organizations.length === 1 ? user.organizations[0] : null);
  if (!selected) throw new Error(`Choose an organization with perch login <id>:\n${user.organizations.map(org => `${org.id}  ${org.name}`).join('\n')}`);
  await saveCredentials(env, { origin, clientId: config.clientId, organizationId: selected.id, accessToken: result.access_token, refreshToken: result.refresh_token });
  stdout(`Signed in to ${selected.name}. CLI scans will use Perch Cloud.`);
}
export async function hasCloudLogin(env) { return Boolean(env.PERCH_TOKEN || await readCredentials(env)); }
export async function logoutCloud({ env, stdout }) {
  await rm(credentialPath(env), { force: true }); stdout('Removed this device\'s saved Perch login. Revoke CI credentials in the dashboard.');
}
export function createCloudClient({ origin, token, organizationId, repositoryId, model = 'jev-latest', epoch = '1', fetchImpl = globalThis.fetch }) {
  const baseUrl = `${origin}/v1/systemone`;
  const client = createSystemOne({ apiKey:token, model, baseUrl, fetchImpl:async (url, options) => {
    const input = JSON.parse(options.body);
    return fetchImpl(url, {...options, body:JSON.stringify({...input,organizationId,repositoryId})});
  } });
  return {...client,cacheKey:hash(JSON.stringify([client.cacheKey,organizationId,repositoryId,token.startsWith('perch_ci_')?hash(token):'user',epoch]))};
}

const usableAccessToken = token => {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp * 1000 > Date.now() + 60000; }
  catch { return false; }
};
async function sessionToken(env, origin, fetchImpl) {
  const current = await readCredentials(env);
  if (usableAccessToken(current?.accessToken)) return current.accessToken;
  // Serialize rotating refresh tokens across CLI processes sharing this login.
  const lock = `${credentialPath(env)}.lock`, deadline = Date.now() + 30000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Another CLI process is refreshing this login. Retry when it finishes.', { cause: error });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try {
    const saved = await readCredentials(env);
    if (!saved || saved.origin !== origin) throw new Error('Cloud login changed. Run perch login again.');
    if (usableAccessToken(saved.accessToken)) return saved.accessToken;
    const result = await request(fetchImpl, 'https://api.workos.com/user_management/authenticate', form({ client_id: saved.clientId, grant_type: 'refresh_token', refresh_token: saved.refreshToken }));
    if (!result.access_token || !result.refresh_token) throw new Error('Cloud session expired. Run perch login.');
    await saveCredentials(env, { ...saved, accessToken: result.access_token, refreshToken: result.refresh_token });
    return result.access_token;
  } finally { await rm(lock, { recursive: true, force: true }); }
}
export async function configuredSystemOne({ env, root, log, fetchImpl = globalThis.fetch }) {
  const saved = env.PERCH_TOKEN || env.PERCH_BASE_URL ? null : await readCredentials(env), origin = cloudOrigin(env);
  // An explicit endpoint overrides a saved cloud login.
  if (!env.PERCH_TOKEN && (env.PERCH_BASE_URL || !saved)) {
    return createSystemOne({ apiKey: env.PERCH_API_KEY || env.TYPESAFE_API_KEY, baseUrl: env.PERCH_BASE_URL, model: env.PERCH_MODEL_ID, log, fetchImpl });
  }
  let token = env.PERCH_TOKEN, organizationId = env.PERCH_ORGANIZATION || saved?.organizationId;
  if (!token) {
    if (saved.origin !== origin) throw new Error('Saved login belongs to a different cloud URL. Run perch login for this endpoint.');
    token = await sessionToken(env, origin, fetchImpl);
  }
  const config = await request(fetchImpl, `${origin}/api/config`);
  let repositoryId = env.PERCH_REPOSITORY;
  if (!token.startsWith('perch_ci_') && !repositoryId) {
    const remote = await git(['config', '--get', 'remote.origin.url'], root).catch(() => '');
    const name = remote.trim().replace(/\.git$/, '').match(/[:/]([^/:]+\/[^/]+)$/)?.[1] || `local/${basename(root)}`;
    const repository = await request(fetchImpl, `${origin}/api/repositories`, post(token, { organizationId, name }));
    repositoryId = repository.id;
  }
  return createCloudClient({ origin, token, organizationId, repositoryId, model: config.model, epoch: config.epoch, fetchImpl });
}
