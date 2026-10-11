import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCloud, waitForRun } from '../src/ci.js';
import { main } from '../src/cli.js';
import { git, revision } from '../src/git.js';
import { formatCloud, formatRun, formatRuns } from '../src/report.js';
import { initRepo } from './helpers.js';

const cleanups = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A checkout on branch work whose origin is acme/web, and a home holding a perch login to workspace org-1. */
async function checkout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'perch-ci-')));
  cleanups.push(root);
  await writeFile(join(root, 'a.js'), 'export const a = 1;\n');
  await initRepo(root);
  await git(['remote', 'add', 'origin', 'git@github.com:acme/web.git'], root);
  const home = join(root, '.home');
  await mkdir(join(home, '.perch'), { recursive: true });
  await writeFile(join(home, '.perch', 'cloud.json'), JSON.stringify({ kind: 'perch', origin: 'https://dash.perchscan.com', organizationId: 'org-1',
    accessToken: 'perch_cli_login', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 }));
  return { root, home };
}

const run = (id, fields = {}) => ({ id, repository_id: 'repo-1', revision: 'a1b2c3d4e5', branch: 'work', pull_request: 318, started_at: 1000,
  finished_at: 2000, exit_code: 0, open_issues: 0, phase: 'complete', completed_methods: 0, total_methods: 0, ...fields });
const findings = [
  { id: 'f1', path: 'src/session.js', method: 'src/session.js::Session.refresh', line: 42, type: 'defect', kind: 'swallowed_error', probability: 0.81, severity: 'P1' },
  { id: 'f2', path: 'docs/setup.md', method: 'docs/setup.md::docs/setup.md', line: 1, type: 'lint', kind: 'docs-show-output', probability: 0.7, severity: null },
];

/**
 * Perch Cloud as far as perch ci and perch cloud read it, recording each request. `runs` are the finished ones, `active` the ones
 * going. A run in `detail` answers comments=1 with its `commented` fields as well. Saving settings changes `repositories` the way
 * Perch Cloud does: enabled flips the switch, and pull request settings replace the saved ones.
 */
function cloud({ runs = [], active = [], detail = {}, repositories = [{ id: 'repo-1', name: 'acme/web', installation_id: 7, pr_scans: 1, ci_configuration: null },
  { id: 'repo-2', name: 'acme/api', installation_id: null, pr_scans: 0, ci_configuration: null }] } = {}) {
  const asked = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url), path = parsed.pathname, body = options.body ? JSON.parse(options.body) : undefined;
    asked.push({ path, query: Object.fromEntries(parsed.searchParams), authorization: options.headers.authorization, ...(body ? { body } : {}) });
    if (path === '/v1/scans/recent') return Response.json({ scans: runs.filter(item => !parsed.searchParams.get('branch') || item.branch === parsed.searchParams.get('branch')), nextCursor: null });
    if (path === '/api/results') return Response.json({ repositories, active });
    const found = detail[parsed.searchParams.get('scanId')];
    if (path === '/v1/scans/detail' && found) return Response.json({ scan: found.scan, findings: found.findings, url: `https://dash.perchscan.com/#/scan/${found.scan.id}`,
      ...(parsed.searchParams.get('comments') === '1' ? found.commented : {}) });
    if (path === '/api/me') return Response.json({ user: { id: 'user_dev', email: 'dev@acme.test', name: 'Dev' }, organizations: [{ id: 'org-1', name: 'Acme' }] });
    if (path === '/api/overview') return Response.json({ organization: { id: 'org-1', name: 'Acme', owner_id: 'user_owner', actor_role: 'admin' }, repositories, github: {} });
    if (path === '/api/repositories/scans' && options.method === 'POST') {
      const repo = repositories.find(item => item.id === body.repositoryId);
      if (body.enabled !== undefined) repo.pr_scans = body.enabled ? 1 : 0;
      if (body.pullRequest) {
        const saved = JSON.parse(repo.ci_configuration || '{}');
        repo.ci_configuration = JSON.stringify({ pullRequest: body.pullRequest.types, scope: { pullRequest: body.pullRequest.scope ?? saved.scope?.pullRequest ?? 'changes' },
          failOnIssues: { pullRequest: body.pullRequest.failOnIssues ?? saved.failOnIssues?.pullRequest ?? true } });
      }
      return Response.json({ repositoryId: repo.id, prScans: Boolean(repo.pr_scans) });
    }
    return Response.json({ error: 'Scan not found.' }, { status: 404 });
  };
  return { asked, fetchImpl };
}

/** perch, run in the checkout against the Cloud given, with what it printed. */
async function perch(args, { root, home, env = {}, fetchImpl }) {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.stubGlobal('fetch', fetchImpl);
  const out = [], err = [];
  const code = await main(args, { stdout: text => out.push(text), stderr: text => err.push(text), env: { HOME: home, ...env } });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('perch ci', () => {
  it('lists the runs of the checked-out branch, the ones still going first, for the repository the remote names', async () => {
    const { root, home } = await checkout();
    const { asked, fetchImpl } = cloud({
      runs: [run('done', { exit_code: 3, open_issues: 2 }), run('main-run', { branch: 'main', pull_request: null })],
      active: [run('going', { exit_code: -1, phase: 'reading', completed_methods: 12, total_methods: 40 }),
        run('elsewhere', { exit_code: -1, branch: 'main' }), run('other-repo', { exit_code: -1, repository_id: 'repo-2' })],
    });
    const listing = await createCloud({ env: { HOME: home }, root, fetchImpl }).runs({ branch: 'work' });
    expect(listing.runs.map(item => item.id)).toEqual(['going', 'done']);
    expect(asked[0]).toEqual({ path: '/v1/scans/recent', query: { organizationId: 'org-1', repository: 'acme/web', branch: 'work' }, authorization: 'Bearer perch_cli_login' });
    const [head, going, done] = formatRuns(listing).split('\n');
    expect(head).toBe(`ID     Commit   Pull request  ${'Result'.padEnd(30)}  When`);
    expect(going).toMatch(/^going {2}a1b2c3d {2}#318 {10}running, 12 of 40 methods read {2}\d+d ago$/);
    expect(done).toMatch(/^done {3}a1b2c3d {2}#318 {10}2 problems, failing {13}\d+d ago$/);
    // Every branch, when the checkout is on none, says which branch each run was of.
    expect(formatRuns({ runs: [run('main-run', { branch: 'main', pull_request: null })], branch: null }).split('\n')[0]).toBe('ID        Commit   Pull request  Branch  Result  When');
    expect(formatRuns({ runs: [], branch: 'work' })).toBe('No CI runs of work in Perch Cloud.');
  });

  it('reads a CI token\'s own repository, and never sends a PERCH_BASE_URL key to Perch Cloud', async () => {
    const { root, home } = await checkout();
    const { asked, fetchImpl } = cloud({ runs: [run('done')] });
    await createCloud({ env: { HOME: home, PERCH_API_KEY: 'perch_ci_token' }, root, fetchImpl }).runs({ branch: 'work' });
    // A token is made for one repository and cannot read the runs still going, which only a login lists.
    expect(asked).toEqual([{ path: '/v1/scans/recent', query: { branch: 'work' }, authorization: 'Bearer perch_ci_token' }]);

    asked.length = 0;
    await createCloud({ env: { HOME: home, PERCH_API_KEY: 'sk-openai', PERCH_BASE_URL: 'https://api.openai.com/v1/decisions' }, root, fetchImpl }).runs({ branch: 'work' });
    expect(new Set(asked.map(request => request.authorization))).toEqual(new Set(['Bearer perch_cli_login']));

    await expect(createCloud({ env: { HOME: join(root, 'nobody') }, root, fetchImpl }).runs())
      .rejects.toThrow('Not signed in to Perch Cloud. Run perch login, or set PERCH_API_KEY to a CI token.');
  });

  it('waits for the run of a commit to start and finish, and gives up on a commit CI never scans', async () => {
    const states = [[], [run('r1', { exit_code: -1 })], [run('r1', { exit_code: -1 })], [run('r1', { exit_code: 3, open_issues: 1 })]];
    let polls = 0, clock = 0;
    const reader = {
      runs: async () => ({ runs: states[Math.min(polls, states.length - 1)] }),
      run: async id => ({ run: states[Math.min(polls, states.length - 1)].find(item => item.id === id), findings: [] }),
    };
    const seen = [];
    const done = await waitForRun(reader, { revision: 'a1b2c3d4e5', progress: item => seen.push(item?.exit_code ?? null),
      sleep: async ms => { polls++; clock += ms; }, now: () => clock });
    expect(done.run).toMatchObject({ id: 'r1', exit_code: 3 });
    expect(seen).toEqual([null, -1, -1]);

    clock = 0;
    await expect(waitForRun({ runs: async () => ({ runs: [run('old', { revision: 'ffff' })] }) },
      { revision: 'a1b2c3d4e5', sleep: async ms => { clock += ms; }, now: () => clock }))
      .rejects.toThrow('No CI run of a1b2c3d has started in Perch Cloud in 10 minutes. Push it, or perch ci lists the runs there are.');
  });

  it('prints a run\'s issues the way a scan does and exits as the run did', async () => {
    const { root, home } = await checkout();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { fetchImpl } = cloud({ detail: {
      found: { scan: run('found', { exit_code: 3, open_issues: 2 }), findings },
      broke: { scan: run('broke', { exit_code: 1, error: 'perch exited with status 1 before it finished the scan.' }), findings: [] },
      clean: { scan: run('clean'), findings: [] },
    } });
    vi.stubGlobal('fetch', fetchImpl);
    const out = [], err = [];
    const io = { stdout: text => out.push(text), stderr: text => err.push(text), env: { HOME: home } };

    expect(await main(['ci', 'found'], io)).toBe(3);
    expect(out.join('\n')).toBe(formatRun({ run: run('found', { exit_code: 3, open_issues: 2 }), findings }));
    expect(out.join('\n')).toContain('src/session.js\n  ID  Line  Severity  Type    Confidence  Problem          Method\n  f1    42  P1        defect         81%  swallowed_error  Session.refresh');
    expect(out.join('\n')).toMatch(/✖ 2 problems in 2 files, failing$/);
    expect(err.join('\n')).toMatch(/^#318 at a1b2c3d, finished \d+d ago: https:\/\/dash\.perchscan\.com\/#\/scan\/found$/);

    out.length = 0;
    expect(await main(['ci', 'broke'], io)).toBe(1);
    expect(out.join('\n')).toBe('✖ the run could not finish: perch exited with status 1 before it finished the scan.');
    out.length = 0;
    expect(await main(['ci', 'clean'], io)).toBe(0);
    expect(out.join('\n')).toBe('✓ nothing to report');
    out.length = 0;
    expect(await main(['ci', 'found', '--json'], io)).toBe(3);
    expect(JSON.parse(out.join(''))).toMatchObject({ run: { id: 'found' }, findings, url: 'https://dash.perchscan.com/#/scan/found' });
  });

  it('will not wait for a commit no remote has', async () => {
    const { root, home } = await checkout();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.stubGlobal('fetch', cloud().fetchImpl);
    const err = [];
    expect(await main(['ci', '--wait'], { stdout: () => {}, stderr: text => err.push(text), env: { HOME: home } })).toBe(1);
    expect(err).toEqual([`perch: ${(await revision(root)).slice(0, 7)} is not on any remote branch, so CI has nothing to scan. Push it, then run perch ci --wait.`]);
  });
  it('says what became of Perch\'s comment on each issue of a pull request run, with the replies under it', async () => {
    const { root, home } = await checkout();
    const commented = {
      links: { cloud: 'https://dash.perchscan.com/#/scan/pr', check: null, pull: 'https://github.com/acme/web/pull/318' },
      findings: [
        { ...findings[0], comment: { url: 'https://github.com/acme/web/pull/318#r1', resolved: false, resolvedByPerch: false,
          replies: [{ author: 'octocat', body: 'Intended: the caller\nchecks first.', createdAt: '2026-10-06T11:00:00Z', url: 'https://github.com/acme/web/pull/318#r2' }] } },
        // Perch resolved this one when a later scan stopped reporting it. Its reply saying so is what the Review column says.
        { ...findings[1], comment: { url: 'https://github.com/acme/web/pull/318#r3', resolved: true, resolvedByPerch: true,
          replies: [{ author: 'perchcode-bot', body: 'The scan of abc1234 no longer reports this, so Perch resolved it.', createdAt: '2026-10-06T12:00:00Z', url: 'https://github.com/acme/web/pull/318#r4' }] } },
      ],
    };
    const stub = cloud({ detail: { pr: { scan: run('pr', { exit_code: 3, open_issues: 2 }), findings, commented },
      off: { scan: run('off', { exit_code: 3, open_issues: 2 }), findings, commented: { commentsNotice: 'Connect this repository in the GitHub App to read its pull request comments.' } } } });
    const { code, out, err } = await perch(['ci', 'pr'], { root, home, fetchImpl: stub.fetchImpl });
    expect(code).toBe(3);
    expect(stub.asked.at(-1).query).toEqual({ organizationId: 'org-1', scanId: 'pr', comments: '1' });
    expect(out).toContain('src/session.js\n  ID  Line  Severity  Type    Confidence  Problem          Review  Method\n'
      + '  f1    42  P1        defect         81%  swallowed_error  open    Session.refresh\n      octocat: Intended: the caller checks first.');
    expect(out).toContain('  f2     1  -         lint         70%  docs-show-output  resolved by Perch  docs/setup.md');
    expect(out).not.toContain('no longer reports this');
    expect(err).toContain('Pull request: https://github.com/acme/web/pull/318');

    // A repository off the GitHub App still lists its issues, with no Review column, and says why there are no comments.
    const off = await perch(['ci', 'off'], { root, home, fetchImpl: stub.fetchImpl });
    expect(off.out).toBe(formatRun({ run: run('off', { exit_code: 3, open_issues: 2 }), findings }));
    expect(off.err).toContain('Connect this repository in the GitHub App to read its pull request comments.');
  });
});

describe('perch cloud', () => {
  it('shows who is signed in, to which workspace, and how Perch Cloud scans this repository', async () => {
    const { root, home } = await checkout();
    const { code, out } = await perch(['cloud'], { root, home, fetchImpl: cloud().fetchImpl });
    expect(code).toBe(0);
    expect(out).toBe([
      'Signed in as   dev@acme.test',
      'Workspace      Acme (admin)',
      'Repository     acme/web',
      'GitHub app     installed',
      'Pull requests  scanned',
      'Asks about     defect, lint, security',
      'Reads          the changed code',
      'Issues         fail the Perch Scan check',
    ].join('\n'));

    // A repository the workspace does not have has no settings to show, and says where to add it.
    const elsewhere = await perch(['cloud'], { root, home, fetchImpl: cloud({ repositories: [] }).fetchImpl });
    expect(elsewhere.out.split('\n').at(-1)).toBe('Repository    acme/web, not in this workspace; add it at https://dash.perchscan.com/#/setup');
    expect(formatCloud(JSON.parse((await perch(['cloud', '--json'], { root, home, fetchImpl: cloud({ repositories: [] }).fetchImpl })).out))).toBe(elsewhere.out);

    // A CI token has no account or workspace to show.
    const token = await perch(['cloud'], { root, home, env: { PERCH_API_KEY: 'perch_ci_token' }, fetchImpl: cloud().fetchImpl });
    expect([token.code, token.err]).toEqual([1, 'perch: perch cloud needs perch login. A CI token reads CI runs and nothing else.']);
  });

  it('changes only what perch cloud set names, and sends the issue types in force with a new scope or gate', async () => {
    const { root, home } = await checkout();
    const stub = cloud();
    const scope = await perch(['cloud', 'set', '--scope', 'all', '--gate', 'no'], { root, home, fetchImpl: stub.fetchImpl });
    expect(scope.code, scope.err).toBe(0);
    // Perch Cloud saves the types with the rest, so leaving them out would have been a request it refuses.
    expect(stub.asked.find(request => request.body).body).toEqual({ organizationId: 'org-1', repositoryId: 'repo-1',
      pullRequest: { types: ['defect', 'lint', 'security'], scope: 'all', failOnIssues: false } });
    expect(scope.out).toContain('Reads          the whole repository\nIssues         are reported, and the check passes');

    stub.asked.length = 0;
    const off = await perch(['cloud', 'set', '--pull_requests', 'no'], { root, home, fetchImpl: stub.fetchImpl });
    expect(stub.asked.find(request => request.body).body).toEqual({ organizationId: 'org-1', repositoryId: 'repo-1', enabled: false });
    expect(off.out).toContain('Pull requests  not scanned\nAsks about     defect, lint, security\nReads          the whole repository');

    const types = await perch(['cloud', 'set', '--scan_types', 'security,defect'], { root, home, fetchImpl: stub.fetchImpl });
    expect(types.out).toContain('Asks about     security, defect');

    const away = await perch(['cloud', 'set', '--scope', 'all'], { root, home, fetchImpl: cloud({ repositories: [] }).fetchImpl });
    expect([away.code, away.err]).toEqual([1, 'perch: acme/web is not in Acme on Perch Cloud. Connect it at https://dash.perchscan.com/#/setup']);
  });

  it.each([
    [['cloud', 'set'], 'perch cloud set needs something to change: --pull_requests, --scan_types, --scope or --gate'],
    [['cloud', '--scope', 'all'], 'perch cloud set changes settings; perch cloud only shows them'],
    [['cloud', 'set', '--scan_types', 'defect,style'], '--scan_types takes defect, security, lint, refactor, docs, not style'],
    [['cloud', 'set', '--scope', 'some'], '--scope is changes or all, not some'],
    [['cloud', 'set', '--gate', 'maybe'], '--gate is yes or no, not maybe'],
    [['cloud', 'show'], 'perch cloud takes set or nothing, not show'],
  ])('refuses %j before asking Perch Cloud anything', async (args, message) => {
    const { root, home } = await checkout();
    const stub = cloud();
    const { code, err } = await perch(args, { root, home, fetchImpl: stub.fetchImpl });
    expect([code, err.split('\n')[0]]).toEqual([2, `perch: ${message}`]);
    expect(stub.asked).toEqual([]);
  });
});
