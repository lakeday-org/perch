/**
 * `perch ci`: what Perch Cloud's CI runs of this repository found, read with the login perch already has. A login reads its
 * workspace's repositories, and the git remote says which one this is; a CI token reads the one repository it was made for.
 */
import { CLOUD_ORIGIN, cloudRequest, readCloudLogin, sessionToken } from './cloud-auth.js';
import { remoteRepositoryName } from './cloud-client.js';
import { git } from './git.js';

/** A run still going has exit code -1 until perch, or Perch Cloud on its behalf, finishes it. */
export const running = run => run.exit_code < 0;

/**
 * PERCH_API_KEY is a CI token unless PERCH_BASE_URL is set, when it is that endpoint's key and means nothing to Perch Cloud. CI
 * results are only ever in Perch Cloud, so a login is used then, the same login perch scan would have used without the endpoint.
 */
async function signIn(env, fetchImpl) {
  if (env.PERCH_API_KEY && !env.PERCH_BASE_URL) return { login: false, getToken: async () => env.PERCH_API_KEY, organizationId: env.PERCH_ORGANIZATION || null };
  const saved = await readCloudLogin(env);
  if (!saved) throw new Error('perch ci reads Perch Cloud. Sign in with perch login, or set PERCH_API_KEY to a CI token.');
  if (saved.origin !== CLOUD_ORIGIN) throw new Error('Saved login is for a different Perch Cloud. Run perch login again.');
  return { login: true, getToken: signal => sessionToken(env, fetchImpl, signal), organizationId: env.PERCH_ORGANIZATION || saved.organizationId };
}

/** Reads CI runs from Perch Cloud for the repository at root. */
export function createCiReader({ env, root, fetchImpl = globalThis.fetch }) {
  let signedIn = null;
  // A refresh in another perch process retires the token this one read, so a 401 is asked again once, with whatever is current.
  const get = async (path, query = {}) => {
    const auth = await (signedIn ??= signIn(env, fetchImpl));
    const url = new URL(path, CLOUD_ORIGIN);
    for (const [key, value] of Object.entries({ organizationId: auth.organizationId, ...query })) if (value != null && value !== '') url.searchParams.set(key, value);
    const send = token => cloudRequest(fetchImpl, url.href, { headers: { authorization: `Bearer ${token}` } }, 30000);
    const token = await auth.getToken();
    try { return await send(token); }
    catch (error) {
      if (error.status !== 401) throw error;
      const next = await auth.getToken();
      if (next === token) throw error;
      return send(next);
    }
  };

  return {
    /**
     * The newest runs of a branch, or of every branch when there is none, newest first. A login also sees the runs still going,
     * which Perch Cloud lists apart from the finished ones; a CI token is shown only what has finished.
     */
    async runs({ branch = null } = {}) {
      const { login } = await (signedIn ??= signIn(env, fetchImpl));
      const repository = login ? remoteRepositoryName(await git(['config', '--get', 'remote.origin.url'], root).catch(() => '')) : null;
      if (login && !repository) throw new Error('This checkout has no origin remote naming a repository, so there are no CI runs to read.');
      const { scans, nextCursor } = await get('/v1/scans/recent', { repository, branch });
      let going = [];
      if (login) {
        const current = await get('/api/results');
        const id = current.repositories.find(repo => repo.name === repository)?.id;
        going = (current.active ?? []).filter(run => run.repository_id === id && (!branch || run.branch === branch));
      }
      return { repository, branch, runs: [...going, ...scans.filter(run => !going.some(other => other.id === run.id))], nextCursor };
    },
    /** One run and every issue it reported. A run still going has the issues it has sent so far. */
    async run(id) {
      const { scan, findings, log, url } = await get('/v1/scans/detail', { scanId: id });
      return { run: scan, findings, log: log ?? null, url };
    },
  };
}

/**
 * Waits for a run to finish and returns it with its issues: the run named, or else the newest run of a commit, which may not have
 * started yet when this is called straight after a push. A commit with no run after `startWithin` is one CI is not scanning, and
 * a run going for longer than `within` is given up on rather than waited on forever.
 */
export async function waitForRun(reader, { id = null, revision = null, branch = null, progress = () => {}, sleep, now = Date.now,
  every = 10_000, startWithin = 10 * 60_000, within = 60 * 60_000 }) {
  const began = now();
  for (;;) {
    let found = id;
    if (!found) {
      const { runs } = await reader.runs({ branch });
      found = runs.filter(run => run.revision === revision).sort((a, b) => b.started_at - a.started_at)[0]?.id ?? null;
    }
    if (found) {
      const detail = await reader.run(found);
      if (!running(detail.run)) return detail;
      progress(detail.run);
      if (now() - began > within) throw new Error(`CI run ${found} is still going after ${Math.round(within / 60_000)} minutes. perch ci ${found} shows it so far.`);
    } else {
      progress(null);
      if (now() - began > startWithin) throw new Error(`No CI run of ${revision.slice(0, 7)} has started in Perch Cloud in ${Math.round(startWithin / 60_000)} minutes. Push it, or perch ci lists the runs there are.`);
    }
    await sleep(every);
  }
}
