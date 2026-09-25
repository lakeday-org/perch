/** Use Perch Cloud as a System One endpoint and publish completed scan summaries. */
import { git } from './git.js';
import { createSystemOne } from './systemone.js';
import {
  actionsCanSignIn, actionsToken, cloudOrigin, cloudRequest, jsonBody, readCloudLogin, sessionToken,
} from './cloud-auth.js';

/** The token supplier refreshes OIDC or user credentials during a long scan. */
export function createCloudClient({
  origin, getToken, identity, organizationId, repositoryId,
  model = 'jev-latest', log, fetchImpl = globalThis.fetch,
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

  return {
    ...gateway,
    ...(repositoryId || identity !== 'user' ? { async report(report) {
      const token = await getToken();
      return cloudRequest(fetchImpl, `${origin}/v1/scans`, jsonBody(token, {
        organizationId, repositoryId, ...report,
      }), 10000);
    } } : {}),
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

async function cloudClient({ env, log, fetchImpl, credentials }) {
  const origin = cloudOrigin(env);
  const config = await cloudRequest(fetchImpl, `${origin}/api/config`);
  return createCloudClient({
    origin, ...credentials,
    model: env.PERCH_MODEL_ID || config.model, log, fetchImpl,
  });
}

async function explicitCredentials({ env, root, fetchImpl }) {
  const token = env.PERCH_TOKEN;
  const organizationId = env.PERCH_ORGANIZATION;
  const repositoryId = token.startsWith('perch_ci_')
    ? env.PERCH_REPOSITORY
    : await repositoryForLogin({
      env, root, origin: cloudOrigin(env), token, organizationId, fetchImpl,
    });

  return {
    getToken: async () => token,
    identity: token.startsWith('perch_ci_') ? 'ci' : 'user',
    organizationId,
    repositoryId,
  };
}

async function savedCredentials({ env, root, fetchImpl, saved }) {
  const origin = cloudOrigin(env);
  if (saved.origin !== origin) {
    throw new Error('Saved login belongs to a different cloud URL. Run perch login for this endpoint.');
  }

  const getToken = () => sessionToken(env, origin, fetchImpl);
  const organizationId = env.PERCH_ORGANIZATION || saved.organizationId;
  const repositoryId = await repositoryForLogin({
    env, root, origin, token: await getToken(), organizationId, fetchImpl,
  });
  return { getToken, identity: 'user', organizationId, repositoryId };
}

function actionsCredentials(env, fetchImpl) {
  return {
    getToken: actionsToken(env, cloudOrigin(env), fetchImpl),
    identity: 'oidc',
  };
}

/** Select the source once for scans and diagnostics. OIDC needs an explicit Cloud URL. */
export async function credentialSource(env) {
  if (env.PERCH_TOKEN) return { kind: 'token' };
  if (env.PERCH_BASE_URL || env.PERCH_API_KEY || env.TYPESAFE_API_KEY) return { kind: 'direct' };
  const saved = await readCloudLogin(env);
  if (saved) return { kind: 'saved', saved };
  if (env.PERCH_CLOUD_URL && actionsCanSignIn(env)) return { kind: 'actions' };
  return { kind: 'direct' };
}

export async function configuredSystemOne({ env, root, log, fetchImpl = globalThis.fetch }) {
  const source = await credentialSource(env);
  if (source.kind === 'token') {
    const credentials = await explicitCredentials({ env, root, fetchImpl });
    return cloudClient({ env, log, fetchImpl, credentials });
  }
  if (source.kind === 'direct') {
    return createSystemOne({
      apiKey: env.PERCH_API_KEY || env.TYPESAFE_API_KEY,
      baseUrl: env.PERCH_BASE_URL,
      model: env.PERCH_MODEL_ID,
      log,
      fetchImpl,
    });
  }

  if (source.kind === 'saved') {
    const credentials = await savedCredentials({ env, root, fetchImpl, saved: source.saved });
    return cloudClient({ env, log, fetchImpl, credentials });
  }
  return cloudClient({ env, log, fetchImpl, credentials: actionsCredentials(env, fetchImpl) });
}
