import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCiReader, waitForRun } from '../src/ci.js';
import { main } from '../src/cli.js';
import { git, revision } from '../src/git.js';
import { formatRun, formatRuns } from '../src/report.js';
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

/** Perch Cloud as far as perch ci reads it, recording each request. `runs` are the finished ones, `active` the ones going. */
function cloud({ runs = [], active = [], detail = {} } = {}) {
  const asked = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    asked.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), authorization: options.headers.authorization });
    if (parsed.pathname === '/v1/scans/recent') return Response.json({ scans: runs.filter(item => !parsed.searchParams.get('branch') || item.branch === parsed.searchParams.get('branch')), nextCursor: null });
    if (parsed.pathname === '/api/results') return Response.json({ repositories: [{ id: 'repo-1', name: 'acme/web' }, { id: 'repo-2', name: 'acme/api' }], active });
    const found = detail[parsed.searchParams.get('scanId')];
    if (parsed.pathname === '/v1/scans/detail' && found) return Response.json({ ...found, url: `https://dash.perchscan.com/#/scan/${found.scan.id}` });
    return Response.json({ error: 'Scan not found.' }, { status: 404 });
  };
  return { asked, fetchImpl };
}

describe('perch ci', () => {
  it('lists the runs of the checked-out branch, the ones still going first, for the repository the remote names', async () => {
    const { root, home } = await checkout();
    const { asked, fetchImpl } = cloud({
      runs: [run('done', { exit_code: 3, open_issues: 2 }), run('main-run', { branch: 'main', pull_request: null })],
      active: [run('going', { exit_code: -1, phase: 'reading', completed_methods: 12, total_methods: 40 }),
        run('elsewhere', { exit_code: -1, branch: 'main' }), run('other-repo', { exit_code: -1, repository_id: 'repo-2' })],
    });
    const listing = await createCiReader({ env: { HOME: home }, root, fetchImpl }).runs({ branch: 'work' });
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
    await createCiReader({ env: { HOME: home, PERCH_API_KEY: 'perch_ci_token' }, root, fetchImpl }).runs({ branch: 'work' });
    // A token is made for one repository and cannot read the runs still going, which only a login lists.
    expect(asked).toEqual([{ path: '/v1/scans/recent', query: { branch: 'work' }, authorization: 'Bearer perch_ci_token' }]);

    asked.length = 0;
    await createCiReader({ env: { HOME: home, PERCH_API_KEY: 'sk-openai', PERCH_BASE_URL: 'https://api.openai.com/v1/decisions' }, root, fetchImpl }).runs({ branch: 'work' });
    expect(new Set(asked.map(request => request.authorization))).toEqual(new Set(['Bearer perch_cli_login']));

    await expect(createCiReader({ env: { HOME: join(root, 'nobody') }, root, fetchImpl }).runs())
      .rejects.toThrow('perch ci reads Perch Cloud. Sign in with perch login, or set PERCH_API_KEY to a CI token.');
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
});
