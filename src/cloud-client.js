/** Use Perch Cloud as a System One endpoint and stream scan results while work continues. */
import { randomUUID } from 'node:crypto';
import { git } from './git.js';
import { createSystemOne } from './systemone.js';
import {
  actionsCanSignIn, actionsToken, CLOUD_ORIGIN, cloudRequest, jsonBody, readCloudLogin, sessionToken,
} from './cloud-auth.js';

/**
 * Refreshing a login retires its access token at once. With many requests in flight, one can read the token just before another
 * refreshes it and arrive holding a token the Cloud no longer knows. A 401 is sent again, once, when the login now holds a
 * different token; a 401 with the current token is a login that has really ended.
 */
export async function withCurrentToken(getToken, signal, send) {
  const token = await getToken(signal);
  const response = await send(token);
  if (response.status !== 401) return response;
  const next = await getToken(signal);
  return next === token ? response : send(next);
}

/**
 * System One through Perch Cloud, which caches answers per repository and bills the organization. getToken is asked before every
 * request, since an OIDC token or a login's access token can expire partway through a long scan.
 *
 * A client can report a finished scan when the Cloud knows which repository it belongs to: a CI token and an OIDC token carry
 * one, and a login names one found from the git remote. A login in a directory with no remote has nowhere to file it.
 */
export function createCloudClient({
  origin, getToken, organizationId, repositoryId, reports,
  model = 'jev-latest', force = false, log, fetchImpl = globalThis.fetch, reportTimeoutMs = 30000,
}) {
  // The Cloud scan this run reports to, once it has been started. A question names it so the Cloud can add up what a scan cost,
  // and one asked while the scan is starting waits to know it. A scan that could not start leaves the questions unnamed.
  let started = null;
  const gateway = createSystemOne({
    apiKey: 'cloud',
    baseUrl: `${origin}/v1/systemone`,
    model,
    log,
    fetchImpl: async (url, options) => {
      const input = JSON.parse(options.body);
      const scan = await started?.then(saved => saved.id, () => null);
      return withCurrentToken(getToken, undefined, token => fetchImpl(url, {
        ...options,
        headers: { ...options.headers, authorization: `Bearer ${token}`, ...(scan ? { 'x-perch-scan': scan } : {}) },
        // A forced request skips the Cloud's cached answers and replaces them with the new ones.
        body: JSON.stringify({ ...input, organizationId, repositoryId, ...(force ? { force: true } : {}) }),
      }));
    },
  });

  if (!reports) return gateway;
  const sendScan = async (path, input) => {
    const signal = AbortSignal.timeout(reportTimeoutMs);
    const send = token => cloudRequest(fetchImpl, `${origin}/v1/scans/${path}`, { ...jsonBody(token, { organizationId, repositoryId, ...input }), signal }, reportTimeoutMs);
    const token = await getToken(signal);
    try { return await send(token); }
    catch (error) {
      if (error.status !== 401) throw error;
      const next = await getToken(signal);
      if (next === token) throw error;
      return send(next);
    }
  };
  return {
    ...gateway,
    startScan: scan => (started = sendScan('start', { scan })),
    appendFindings: (scanId, findings) => sendScan('append', { scanId, findings }),
    updateScan: (scanId, progress) => sendScan('progress', { scanId, progress }),
    finishScan: (scanId, scan) => sendScan('finish', { scanId, scan }),
  };
}

/** Keep every namespace segment; a GitLab subgroup is part of the repository's identity. */
export function remoteRepositoryName(remote) {
  let path;
  const text = remote?.trim();
  if (!text) return null;
  if (/^(?:https?|ssh|git):\/\//.test(text)) {
    try { path = new URL(text).pathname; } catch { return null; }
  } else {
    path = /^[^@/]+@[^:/]+:(.+)$/.exec(text)?.[1];
  }
  const parts = path?.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
  if (!parts || parts.length < 2 || !parts.every(part => /^[a-zA-Z0-9._-]+$/.test(part) && part !== '.' && part !== '..')) return null;
  return parts.join('/');
}

/** A login is not tied to a repository, so the git remote names it and the Cloud registers it on first use. */
async function repositoryForLogin({ env, root, token, organizationId, fetchImpl }) {
  if (env.PERCH_REPOSITORY) return env.PERCH_REPOSITORY;
  const remote = await git(['config', '--get', 'remote.origin.url'], root).catch(() => '');
  const name = remoteRepositoryName(remote);
  if (!name) return null;
  const repository = await cloudRequest(fetchImpl, `${CLOUD_ORIGIN}/api/repositories`, jsonBody(token, {
    organizationId, name,
  }));
  return repository.id;
}

/** The Cloud says which model it serves; PERCH_MODEL_ID asks for another. */
async function cloudClient({ env, log, fetchImpl, credentials, force }) {
  const config = await cloudRequest(fetchImpl, `${CLOUD_ORIGIN}/api/config`);
  return createCloudClient({ origin: CLOUD_ORIGIN, ...credentials, model: env.PERCH_MODEL_ID || config.model, force, log, fetchImpl });
}

/** A CI token from the dashboard. It is issued for one repository, so the Cloud knows which without being told. */
function tokenCredentials(env) {
  return { getToken: async () => env.PERCH_API_KEY, organizationId: env.PERCH_ORGANIZATION, repositoryId: env.PERCH_REPOSITORY, reports: true };
}

/** A login from perch login. One made against another Cloud, such as the old staging one, has to be made again. */
async function savedCredentials({ env, root, fetchImpl, saved }) {
  if (saved.origin !== CLOUD_ORIGIN) throw new Error('Saved login is for a different Perch Cloud. Run perch login again.');
  const getToken = signal => sessionToken(env, fetchImpl, signal);
  const organizationId = env.PERCH_ORGANIZATION || saved.organizationId;
  const repositoryId = await repositoryForLogin({ env, root, token: await getToken(), organizationId, fetchImpl });
  return { getToken, organizationId, repositoryId, reports: Boolean(repositoryId) };
}

/** A GitHub Actions job's OIDC token. The Cloud maps its repository claim to a connected repository. */
function actionsCredentials(env, fetchImpl) {
  return { getToken: actionsToken(env, CLOUD_ORIGIN, fetchImpl), reports: true };
}

/**
 * Where scans send their questions, decided once so scan, check and doctor agree. Perch Cloud unless PERCH_BASE_URL names another
 * endpoint, and then PERCH_API_KEY is that endpoint's key. Otherwise PERCH_API_KEY is a CI token from the dashboard, then a login
 * saved on this machine, then a GitHub Actions job's own OIDC token, which needs no secret at all.
 */
export async function credentialSource(env) {
  if (env.PERCH_BASE_URL) return { kind: 'direct' };
  if (env.PERCH_API_KEY) return { kind: 'token' };
  const saved = await readCloudLogin(env);
  if (saved) return { kind: 'saved', saved };
  if (actionsCanSignIn(env)) return { kind: 'actions' };
  return { kind: 'none' };
}

/**
 * What a model takes in one request, when it does not say. PERCH_MAX_QUESTIONS and PERCH_MAX_OPTIONS set the limits for an
 * endpoint that reports nothing in `_meta`; one that does report can only lower them. A value that is not a whole number above
 * zero is an error rather than no limit, since a scan sent in batches the model refuses reads nothing.
 */
function limitsFrom(env) {
  const limits = {};
  for (const [name, key, least] of [['PERCH_MAX_QUESTIONS', 'questions', 1], ['PERCH_MAX_OPTIONS', 'options', 2]]) {
    if (env[name] === undefined || env[name] === '') continue;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value < least) throw new Error(`${name} must be a whole number of at least ${least}, not ${env[name]}`);
    limits[key] = value;
  }
  return limits;
}

/** The first request to an endpoint that has not said what it takes. Small enough for any model we know of; its answer says the rest. */
export const FIRST_QUESTIONS = 8;

/**
 * Every request to the Cloud says which command sent it, from which release, and which run it belongs to. The run is a new id
 * each time perch is invoked and the same on every request that invocation makes, so the Cloud can put a run's requests together.
 */
const sendingAs = (fetchImpl, command, version) => {
  const headers = { 'x-perch-command': command, 'x-perch-version': version, 'x-perch-run': randomUUID() };
  return (url, options = {}) => fetchImpl(url, { ...options, headers: { ...headers, ...options.headers } });
};

export async function configuredSystemOne({ env, root, log, command, version, force = false, fetchImpl = globalThis.fetch }) {
  const source = await credentialSource(env);
  if (source.kind === 'none') throw new Error('Not signed in to Perch Cloud. Run perch login, or set PERCH_API_KEY to a CI token from the dashboard.');
  if (source.kind === 'direct') {
    const limits = limitsFrom(env);
    return createSystemOne({ apiKey: env.PERCH_API_KEY || env.TYPESAFE_API_KEY, baseUrl: env.PERCH_BASE_URL, model: env.PERCH_MODEL_ID, log, fetchImpl,
      limits, firstQuestions: limits.questions ?? FIRST_QUESTIONS });
  }
  const cloudFetch = sendingAs(fetchImpl, command, version);
  // An Actions job asks GitHub for its token, which is not a request to the Cloud.
  const credentials = source.kind === 'token' ? tokenCredentials(env)
    : source.kind === 'saved' ? await savedCredentials({ env, root, fetchImpl: cloudFetch, saved: source.saved })
      : actionsCredentials(env, fetchImpl);
  return cloudClient({ env, log, fetchImpl: cloudFetch, credentials, force });
}
