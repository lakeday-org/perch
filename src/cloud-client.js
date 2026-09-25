/** Use Perch Cloud as a System One endpoint and publish completed scan summaries. */
import { createHash } from 'node:crypto';
import { git } from './git.js';
import { createSystemOne } from './systemone.js';
import {
  actionsCanSignIn, actionsToken, cloudOrigin, cloudRequest, jsonBody, readCloudLogin, sessionToken,
} from './cloud-auth.js';

const hash = value => createHash('sha256').update(value).digest('hex');

/** The token supplier refreshes OIDC or user credentials during a long scan. */
export function createCloudClient({
  origin, getToken, identity, organizationId, repositoryId,
  model = 'jev-latest', epoch = '1', log, fetchImpl = globalThis.fetch,
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
    cacheKey: hash(JSON.stringify([gateway.cacheKey, organizationId, repositoryId, identity, epoch])),
    ...(repositoryId || identity !== 'user' ? { async report(report) {
      const token = await getToken();
      return cloudRequest(fetchImpl, `${origin}/v1/scans`, jsonBody(token, {
        organizationId, repositoryId, ...report,
      }));
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
    model: env.PERCH_MODEL_ID || config.model, epoch: config.epoch, log, fetchImpl,
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
    identity: token.startsWith('perch_ci_') ? hash(token) : 'user',
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

/** Explicit credentials win; a saved login follows; GitHub OIDC is the last option. */
export async function configuredSystemOne({ env, root, log, fetchImpl = globalThis.fetch }) {
  if (env.PERCH_TOKEN) {
    const credentials = await explicitCredentials({ env, root, fetchImpl });
    return cloudClient({ env, log, fetchImpl, credentials });
  }
  if (env.PERCH_BASE_URL || env.PERCH_API_KEY || env.TYPESAFE_API_KEY) {
    return createSystemOne({
      apiKey: env.PERCH_API_KEY || env.TYPESAFE_API_KEY,
      baseUrl: env.PERCH_BASE_URL,
      model: env.PERCH_MODEL_ID,
      log,
      fetchImpl,
    });
  }

  const saved = await readCloudLogin(env);
  if (saved) {
    const credentials = await savedCredentials({ env, root, fetchImpl, saved });
    return cloudClient({ env, log, fetchImpl, credentials });
  }
  if (actionsCanSignIn(env)) {
    return cloudClient({ env, log, fetchImpl, credentials: actionsCredentials(env, fetchImpl) });
  }
  return createSystemOne({ log, fetchImpl });
}
