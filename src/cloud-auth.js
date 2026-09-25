/** Credentials for Perch Cloud. Nothing in this file reads or writes the scanned repository. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The Cloud when no URL is set: where perch login signs in, and the Cloud a saved login has to have been made against. */
export const CLOUD_ORIGIN = 'https://dash.perchscan.com';
// The Cloud signs users in through WorkOS, so the device flow and token refresh talk to WorkOS directly, with the client id the
// Cloud publishes at /api/config.
const WORKOS_AUTH = 'https://api.workos.com/user_management/authenticate';
const DEVICE_AUTH = 'https://api.workos.com/user_management/authorize/device';
/** A pause, passed in to login so tests do not wait out the polling interval. */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The Cloud's origin, checked before anything is sent to it, since a login's tokens and a repository's code go there. HTTPS only,
 * except on localhost for running the Cloud locally. A path or query is refused because perch appends its own routes.
 */
export function cloudOrigin(env) {
  const value = env.PERCH_CLOUD_URL || CLOUD_ORIGIN;
  let url;
  try { url = new URL(value); }
  catch { throw new Error('PERCH_CLOUD_URL must be a valid origin.'); }

  const localhost = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localhost) throw new Error('PERCH_CLOUD_URL must use HTTPS.');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('PERCH_CLOUD_URL must be an origin without credentials or a path.');
  }
  return url.origin;
}

/**
 * One request to the Cloud or WorkOS, returning the parsed body. A failure carries the server's own error text and status, which
 * says more than a status code does. Every request has a deadline: a Cloud that never answers must not hang a scan or CI.
 */
export async function cloudRequest(fetchImpl, url, options = {}, timeoutMs = 150000) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetchImpl(url, { ...options, signal });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.error_description || data?.error || `Cloud request failed (${response.status})`;
    throw Object.assign(new Error(detail), { status: response.status });
  }
  if (data === null) throw new Error('Perch Cloud returned an invalid response.');
  return data;
}

/** A POST of form fields, which is what WorkOS's OAuth endpoints take. */
export const formBody = input => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(input),
});

/** A POST of JSON with the bearer token, which is what the Cloud's own endpoints take. */
export const jsonBody = (token, input) => ({
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(input),
});

/** Under the home directory, not the repository: a login is a person's, and a file in the checkout could be committed. */
const loginPath = env => join(env.HOME || homedir(), '.perch', 'cloud.json');

/** The saved login, or null when there is none. A file that is there and does not parse is an error rather than no login. */
export async function readCloudLogin(env) {
  try { return JSON.parse(await readFile(loginPath(env), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Could not read Perch login. Run perch logout, then perch login.', { cause: error });
  }
}

/**
 * Written beside and moved into place, readable by this user alone. A refresh rotates the refresh token, so a half-written file
 * would lose the only one that still works and sign the user out.
 */
async function saveCloudLogin(env, credentials) {
  const path = loginPath(env);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(credentials) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Polls WorkOS until the code is confirmed in the browser, or the code expires. slow_down is WorkOS asking for a longer interval,
 * and each one adds five seconds, as the device flow specifies. The wait is capped at ten minutes whatever the code allows.
 */
async function waitForDeviceToken({ clientId, device, fetchImpl, sleep }) {
  const deadline = Date.now() + Math.min(device.expires_in, 600) * 1000;
  let interval = Math.max(5, device.interval || 5);

  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const response = await fetchImpl(WORKOS_AUTH, {
      ...formBody({
        client_id: clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') throw new Error('Perch Cloud sign-in returned an invalid response. Run perch login again.');
    if (response.ok) return data;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { interval += 5; continue; }
    throw new Error('Sign-in was denied or expired. Run perch login again.');
  }
  throw new Error('Sign-in timed out. Run perch login again.');
}

/**
 * perch login: a device code confirmed in the browser, so no password or secret passes through the terminal. What is saved is
 * scoped to one Cloud and one organization; with several organizations and none named, it lists them rather than guessing.
 * The device code and the tokens are never printed, only the code the user types.
 */
export async function loginCloud({ env, organization, stdout, fetchImpl = globalThis.fetch, sleep = wait }) {
  const origin = cloudOrigin(env);
  const { clientId } = await cloudRequest(fetchImpl, `${origin}/api/config`);
  if (typeof clientId !== 'string' || !clientId) throw new Error('Perch Cloud sign-in is not configured yet.');

  const device = await cloudRequest(fetchImpl, DEVICE_AUTH, formBody({ client_id: clientId }));
  if (typeof device.device_code !== 'string' || !device.device_code || typeof device.user_code !== 'string' || !device.user_code
    || typeof device.verification_uri !== 'string' || !device.verification_uri.startsWith('https://')
    || !Number.isFinite(device.expires_in) || device.expires_in <= 0
    || (device.interval !== undefined && (!Number.isFinite(device.interval) || device.interval <= 0))) {
    throw new Error('Perch Cloud sign-in returned an invalid device code. Run perch login again.');
  }
  stdout(`Open ${device.verification_uri}\nEnter code: ${device.user_code}`);
  const session = await waitForDeviceToken({ clientId, device, fetchImpl, sleep });
  if (typeof session.access_token !== 'string' || !session.access_token
    || typeof session.refresh_token !== 'string' || !session.refresh_token) {
    throw new Error('Perch Cloud sign-in returned invalid credentials. Run perch login again.');
  }

  const user = await cloudRequest(fetchImpl, `${origin}/api/me`, {
    headers: { authorization: `Bearer ${session.access_token}` },
  });
  if (!Array.isArray(user.organizations) || !user.organizations.every(org => org && typeof org.id === 'string' && typeof org.name === 'string')) {
    throw new Error('Perch Cloud sign-in returned an invalid organization list. Run perch login again.');
  }
  const requested = organization || env.PERCH_ORGANIZATION;
  const selected = requested
    ? user.organizations.find(org => org.id === requested)
    : user.organizations.length === 1 ? user.organizations[0] : null;
  if (!selected) {
    const choices = user.organizations.map(org => `${org.id}  ${org.name}`).join('\n');
    throw new Error(`Choose an organization with perch login <id>:\n${choices}`);
  }

  await saveCloudLogin(env, {
    origin,
    clientId,
    organizationId: selected.id,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  });
  stdout(`Signed in to ${selected.name}. CLI scans will use Perch Cloud.`);
}

/** Removes this device's login. A CI token lives in the dashboard and is revoked there, which the message says. */
export async function logoutCloud({ env, stdout }) {
  await rm(loginPath(env), { force: true });
  stdout('Removed this device\'s saved Perch login. Revoke CI credentials in the dashboard.');
}

/** GitHub sets these two only in a job with `id-token: write`. Being able to mint a token is not opting in; see credentialSource. */
export const actionsCanSignIn = env => Boolean(
  env.GITHUB_ACTIONS && env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
);

/** GitHub's OIDC token expires during long scans, so ask again before each five-minute window ends. */
export function actionsToken(env, audience, fetchImpl = globalThis.fetch) {
  let cached = null;
  return async signal => {
    if (cached && cached.until > Date.now()) return cached.value;
    const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    url.searchParams.set('audience', audience);
    const response = await fetchImpl(url, {
      headers: { authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.value) {
      throw new Error('GitHub did not issue an OIDC token. Give the job `permissions: id-token: write`.');
    }
    cached = { value: data.value, until: Date.now() + 4 * 60_000 };
    return cached.value;
  };
}

/**
 * Whether a saved access token has more than a minute left, read from its own expiry. A token that does not decode counts as
 * expired, which costs a refresh rather than a failed request.
 */
function accessTokenValid(token) {
  if (typeof token !== 'string') return false;
  try {
    const [, encoded] = token.split('.');
    if (!encoded) return false;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    return Number.isFinite(payload?.exp) && payload.exp * 1000 > Date.now() + 60_000;
  } catch { return false; }
}

/**
 * A directory as a lock, because mkdir either creates it or fails, even across processes. Two scans refreshing at once would
 * each spend the same refresh token, and WorkOS rotates it on use, so the second would sign the user out. A lock older than
 * five minutes is from a process that died holding it.
 */
async function acquireRefreshLock(lock, signal) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try { await mkdir(lock, { mode: 0o700 }); return; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const age = Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
      if (age > 5 * 60_000) await rm(lock, { recursive: true, force: true });
      else await wait(100);
    }
  }
  throw new Error('Another CLI process is refreshing this login. Retry when it finishes.');
}

/**
 * A current access token for the saved login, refreshed when it is about to expire. The login is read again inside the lock,
 * since another process may have refreshed it while this one waited.
 */
export async function sessionToken(env, origin, fetchImpl, signal) {
  signal?.throwIfAborted();
  const current = await readCloudLogin(env);
  if (!current || current.origin !== origin) throw new Error('Cloud login changed. Run perch login again.');
  if (accessTokenValid(current?.accessToken)) return current.accessToken;

  const lock = `${loginPath(env)}.lock`;
  await acquireRefreshLock(lock, signal);
  try {
    const saved = await readCloudLogin(env);
    if (!saved || saved.origin !== origin) throw new Error('Cloud login changed. Run perch login again.');
    if (accessTokenValid(saved.accessToken)) return saved.accessToken;

    const session = await cloudRequest(fetchImpl, WORKOS_AUTH, { ...formBody({
      client_id: saved.clientId,
      grant_type: 'refresh_token',
      refresh_token: saved.refreshToken,
    }), signal });
    if (typeof session.access_token !== 'string' || !session.access_token
      || typeof session.refresh_token !== 'string' || !session.refresh_token) {
      throw new Error('Cloud session expired. Run perch login.');
    }
    await saveCloudLogin(env, {
      ...saved,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    });
    return session.access_token;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
