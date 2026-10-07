/**
 * `perch ci` and `perch cloud`: what Perch Cloud's CI runs of this repository found, and how Perch Cloud scans it, read with the
 * login perch already has. A login reads its workspace's repositories, and the git remote says which one this is; a CI token reads
 * the runs of the one repository it was made for, and nothing else.
 */
import { CLOUD_ORIGIN, cloudRequest, readCloudLogin, sessionToken } from './cloud-auth.js';
import { remoteRepositoryName } from './cloud-client.js';
import { git } from './git.js';

/** A run still going has exit code -1 until perch, or Perch Cloud on its behalf, finishes it. */
export const running = run => run.exit_code < 0;

/** What a pull request scan can ask about, in the order the dashboard lists them. */
export const SCAN_TYPES = ['defect', 'security', 'lint', 'refactor', 'docs'];
/** What a repository's pull request scans ask when nothing has been saved: what Perch's runner and the dashboard both assume. */
const DEFAULT_SCAN_TYPES = ['defect', 'lint', 'security'];
export const SETUP_URL = `${CLOUD_ORIGIN}/#/setup`;

/**
 * PERCH_API_KEY is a CI token unless PERCH_BASE_URL is set, when it is that endpoint's key and means nothing to Perch Cloud. CI
 * results are only ever in Perch Cloud, so a login is used then, the same login perch scan would have used without the endpoint.
 */
async function signIn(env, fetchImpl) {
  if (env.PERCH_API_KEY && !env.PERCH_BASE_URL) return { login: false, getToken: async () => env.PERCH_API_KEY, organizationId: env.PERCH_ORGANIZATION || null };
  const saved = await readCloudLogin(env);
  if (!saved) throw new Error('Not signed in to Perch Cloud. Run perch login, or set PERCH_API_KEY to a CI token.');
  if (saved.origin !== CLOUD_ORIGIN) throw new Error('Saved login is for a different Perch Cloud. Run perch login again.');
  return { login: true, getToken: signal => sessionToken(env, fetchImpl, signal), organizationId: env.PERCH_ORGANIZATION || saved.organizationId };
}

/** The repository the origin remote names. --default answers a checkout with no origin with nothing, so a failing git is an error. */
const repositoryAt = async root => remoteRepositoryName(await git(['config', '--default', '', '--get', 'remote.origin.url'], root));

/**
 * A repository's pull request scan settings, from what it saved or the defaults, the way the dashboard reads them. Perch Cloud
 * writes them with JSON.stringify, so settings that do not parse are a fault to report rather than a reason to show defaults.
 */
function pullRequestSettings(repository) {
  const saved = JSON.parse(repository.ci_configuration || '{}') ?? {};
  return { scans: Boolean(repository.pr_scans), types: saved.pullRequest?.length ? saved.pullRequest : DEFAULT_SCAN_TYPES,
    scope: saved.scope?.pullRequest || 'changes', gate: saved.failOnIssues?.pullRequest ?? true };
}

/** Perch Cloud, for the repository at root: its CI runs, and how Perch Cloud scans it. */
export function createCloud({ env, root, fetchImpl = globalThis.fetch }) {
  let signedIn = null;
  const auth = () => (signedIn ??= signIn(env, fetchImpl));
  // A refresh in another perch process retires the token this one read, so a 401 is asked again once, with whatever is current.
  // A GET names the workspace in the query and a POST in its body, which is where Perch Cloud looks for each.
  const request = async (path, query = {}, data = undefined) => {
    const { getToken, organizationId } = await auth();
    const url = new URL(path, CLOUD_ORIGIN);
    for (const [key, value] of Object.entries({ ...(data ? {} : { organizationId }), ...query })) if (value != null && value !== '') url.searchParams.set(key, value);
    const send = token => cloudRequest(fetchImpl, url.href, { headers: { authorization: `Bearer ${token}`, ...(data ? { 'content-type': 'application/json' } : {}) },
      ...(data ? { method: 'POST', body: JSON.stringify({ organizationId, ...data }) } : {}) }, 30000);
    const token = await getToken();
    try { return await send(token); }
    catch (error) {
      if (error.status !== 401) throw error;
      const next = await getToken();
      if (next === token) throw error;
      return send(next);
    }
  };
  // The account and workspace are a person's. A CI token has neither, and Perch Cloud refuses it them.
  const needLogin = async () => {
    if (!(await auth()).login) throw new Error('perch cloud needs perch login. A CI token reads CI runs and nothing else.');
  };

  const cloud = {
    /**
     * The newest runs of a branch, or of every branch when there is none, newest first. A login also sees the runs still going,
     * which Perch Cloud lists apart from the finished ones; a CI token is shown only what has finished.
     */
    async runs({ branch = null } = {}) {
      const { login } = await auth();
      const repository = login ? await repositoryAt(root) : null;
      if (login && !repository) throw new Error('This checkout has no origin remote naming a repository, so there are no CI runs to read.');
      const { scans, nextCursor } = await request('/v1/scans/recent', { repository, branch });
      let going = [];
      if (login) {
        const current = await request('/api/results');
        const id = current.repositories.find(repo => repo.name === repository)?.id;
        going = (current.active ?? []).filter(run => run.repository_id === id && (!branch || run.branch === branch));
      }
      return { repository, branch, runs: [...going, ...scans.filter(run => !going.some(other => other.id === run.id))], nextCursor };
    },
    /**
     * One run and every issue it reported. A run still going has the issues it has sent so far. With comments, a pull request
     * run's issues each carry Perch's review comment on them from GitHub: whether it is resolved, and the replies.
     */
    async run(id, { comments = false } = {}) {
      const { scan, findings, log, url, links, commentsNotice } = await request('/v1/scans/detail', { scanId: id, ...(comments ? { comments: '1' } : {}) });
      return { run: scan, findings, log: log ?? null, url, links: links ?? null, commentsNotice: commentsNotice ?? null };
    },
    /** Who is signed in, to which workspace, and how Perch Cloud scans this checkout's repository, if the workspace has it. */
    async settings() {
      await needLogin();
      const name = await repositoryAt(root);
      const [{ user }, { organization, repositories }] = await Promise.all([request('/api/me'), request('/api/overview', { includePeople: '0' })]);
      const repository = repositories.find(repo => repo.name === name) ?? null;
      // The owner is whoever the workspace names, whatever role WorkOS holds for them; the dashboard's member list says the same.
      const role = organization.owner_id === user.id ? 'owner' : organization.actor_role ?? null;
      return { user: { email: user.email, name: user.name ?? null }, organization: { id: organization.id, name: organization.name, role },
        repository: name, repositoryId: repository?.id ?? null, github: repository ? Boolean(repository.installation_id) : null,
        pullRequests: repository ? pullRequestSettings(repository) : null, url: SETUP_URL };
    },
    /**
     * Changes how Perch Cloud scans this repository's pull requests: whether it does, what a scan asks about, whether it reads the
     * changes or the whole repository, and whether issues fail the check. What is not named stays as it is; Perch Cloud saves
     * the issue types with the rest, so the ones in force are sent again when only the scope or the gate changes.
     */
    async configure({ scans, types, scope, gate }) {
      const current = await cloud.settings();
      if (!current.repositoryId) throw new Error(`${current.repository ?? 'This checkout'} is not in ${current.organization.name} on Perch Cloud. Connect it at ${SETUP_URL}`);
      const settings = types !== undefined || scope !== undefined || gate !== undefined
        ? { pullRequest: { types: types ?? current.pullRequests.types, scope, failOnIssues: gate } } : {};
      await request('/api/repositories/scans', {}, { repositoryId: current.repositoryId, enabled: scans, ...settings });
      return cloud.settings();
    },
  };
  return cloud;
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
