/** Use Perch Cloud as a System One endpoint and publish completed scan summaries. */
import { git } from './git.js';
import { createSystemOne } from './systemone.js';
import {
  actionsCanSignIn, actionsToken, cloudOrigin, cloudRequest, jsonBody, readCloudLogin, sessionToken,
} from './cloud-auth.js';

/**
 * System One through Perch Cloud, which caches answers per repository and bills the organization. getToken is asked before every
 * request, since an OIDC token or a login's access token can expire partway through a long scan.
 *
 * A client can report a finished scan when the Cloud knows which repository it belongs to: a CI token and an OIDC token carry
 * one, and a login names one found from the git remote. A login in a directory with no remote has nowhere to file it.
 */
export function createCloudClient({
  origin, getToken, organizationId, repositoryId, reports,
  model = 'jev-latest', log, fetchImpl = globalThis.fetch, reportTimeoutMs = 10000,
}) {
  const gateway = createSystemOne({
    apiKey: 'cloud',
    baseUrl: `${origin}/v1/systemone`,
    model,
    log,
    fetchImpl: async (url, options) => {
      const input = JSON.parse(options.body);
      const token = await getToken();
      return fetchImpl(url, {
        ...options,
        headers: { ...options.headers, authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...input, organizationId, repositoryId }),
      });
    },
  });

  if (!reports) return gateway;
  return {
    ...gateway,
    /** The scan's result is its exit code, so a slow Cloud gets ten seconds, token included, rather than holding up CI. */
    async report(report) {
      const signal = AbortSignal.timeout(reportTimeoutMs);
      const token = await getToken(signal);
      return cloudRequest(fetchImpl, `${origin}/v1/scans`, { ...jsonBody(token, { organizationId, repositoryId, ...report }), signal }, reportTimeoutMs);
    },
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
async function repositoryForLogin({ env, root, origin, token, organizationId, fetchImpl }) {
  if (env.PERCH_REPOSITORY) return env.PERCH_REPOSITORY;
  const remote = await git(['config', '--get', 'remote.origin.url'], root).catch(() => '');
  const name = remoteRepositoryName(remote);
  if (!name) return null;
  const repository = await cloudRequest(fetchImpl, `${origin}/api/repositories`, jsonBody(token, {
    organizationId, name,
  }));
  return repository.id;
}

/** The Cloud says which model it serves; PERCH_MODEL_ID asks for another. */
async function cloudClient({ env, log, fetchImpl, credentials }) {
  const origin = cloudOrigin(env);
  const config = await cloudRequest(fetchImpl, `${origin}/api/config`);
  return createCloudClient({
    origin, ...credentials,
    model: env.PERCH_MODEL_ID || config.model, log, fetchImpl,
  });
}

/** A CI token from the dashboard. It is issued for one repository, so the Cloud knows which without being told. */
function tokenCredentials(env) {
  return { getToken: async () => env.PERCH_TOKEN, organizationId: env.PERCH_ORGANIZATION, repositoryId: env.PERCH_REPOSITORY, reports: true };
}

/** A login from perch login. It belongs to the Cloud it was made against, so one made on staging never signs in to production. */
async function savedCredentials({ env, root, fetchImpl, saved }) {
  const origin = cloudOrigin(env);
  if (saved.origin !== origin) {
    throw new Error('Saved login belongs to a different cloud URL. Run perch login for this endpoint.');
  }

  const getToken = signal => sessionToken(env, origin, fetchImpl, signal);
  const organizationId = env.PERCH_ORGANIZATION || saved.organizationId;
  const repositoryId = await repositoryForLogin({
    env, root, origin, token: await getToken(), organizationId, fetchImpl,
  });
  return { getToken, organizationId, repositoryId, reports: Boolean(repositoryId) };
}

/** A GitHub Actions job's OIDC token. The Cloud maps its repository claim to a connected repository. */
function actionsCredentials(env, fetchImpl) {
  return { getToken: actionsToken(env, cloudOrigin(env), fetchImpl), reports: true };
}

/**
 * Where scans send their questions, decided once so scan, check and doctor agree. A CI token is the most deliberate choice there
 * is. A key or endpoint set for this shell comes before a login saved weeks ago, so a direct run is never quietly billed to the
 * Cloud. OIDC comes last and only with a Cloud URL: a job can mint one for any audience, and permission to deploy somewhere is
 * not a decision to send this repository's code to Perch Cloud.
 */
export async function credentialSource(env) {
  if (env.PERCH_TOKEN) return { kind: 'token' };
  if (env.PERCH_BASE_URL || env.PERCH_API_KEY || env.TYPESAFE_API_KEY) return { kind: 'direct' };
  const saved = await readCloudLogin(env);
  if (saved) return { kind: 'saved', saved };
  if (env.PERCH_CLOUD_URL && actionsCanSignIn(env)) return { kind: 'actions' };
  // Nothing set at all is a direct run without a key, which fails asking for PERCH_API_KEY: the error a new user should see.
  return { kind: 'direct' };
}

export async function configuredSystemOne({ env, root, log, fetchImpl = globalThis.fetch }) {
  const source = await credentialSource(env);
  if (source.kind === 'direct') {
    return createSystemOne({ apiKey: env.PERCH_API_KEY || env.TYPESAFE_API_KEY, baseUrl: env.PERCH_BASE_URL, model: env.PERCH_MODEL_ID, log, fetchImpl });
  }
  const credentials = source.kind === 'token' ? tokenCredentials(env)
    : source.kind === 'saved' ? await savedCredentials({ env, root, fetchImpl, saved: source.saved })
      : actionsCredentials(env, fetchImpl);
  return cloudClient({ env, log, fetchImpl, credentials });
}
