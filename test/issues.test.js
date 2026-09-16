import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discardFinding, issueBody, issueTitle, marker, publishFinding, publishIssue } from '../src/issues.js';
import { branchFor, openPullRequest, pullRequestBody, pullRequestTitle } from '../src/pr.js';
import { describeFinding } from '../src/describe.js';
import { git, revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { runHunt } from '../src/hunt.js';
import { runFix } from '../src/fix.js';
import { createShell } from '../src/shell.js';
import { openStore } from '../src/store.js';
import { formatFinding, formatIssues, formatPublished } from '../src/report.js';
import { description, fixedSource, fixtureOptions, makeFixture, regressionSource, scriptedModel, scriptedSystemOne } from './helpers.js';

const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

const bare = { id: 'abcd1234', method: 'src/clamp.js::clamp', name: 'clamp', path: 'src/clamp.js', line: 1, end_line: 5, revision: 'deadbeef0123', has_bug: 0.82,
  kind: { kind: 'wrong_return', probability: 0.7 }, severity: { level: 'major' }, where: { line: 3, text: 'if (v > hi) return v;' },
  misuse: [{ callee: 'src/x.js::helper', probability: 0.6 }], misused_by: [] };
const finding = { ...bare, description: { ...description, what_changed: '' } };
const github = { owner: 'o', repo: 'r' };
const noModelTalk = text => { expect(text).not.toMatch(/System One|model|probab|confiden|likely|%/i); };

describe('perch publish', () => {
  it('files an issue written from the description, in plain words, with the marker for later runs', async () => {
    const calls = [];
    const run = async args => { calls.push(args); return args[1] === 'list' ? '[]' : 'Creating issue\nhttps://github.com/o/r/issues/7\n'; };
    const published = await publishIssue({ finding, github, run });
    expect(published).toMatchObject({ github_url: 'https://github.com/o/r/issues/7', github_status: 'created' });
    expect(calls[0].slice(0, 7)).toEqual(['issue', 'list', '-R', 'o/r', '--state', 'all', '--search']);
    expect(calls[0][7]).toBe('"perch abcd1234" in:body');
    expect(calls[1].slice(0, 6)).toEqual(['issue', 'create', '-R', 'o/r', '--title', 'clamp returns values above the upper bound unchanged']);
    expect(issueTitle(finding)).toBe(description.title);
    const body = issueBody(finding);
    expect(body).toBe(`${description.what_happens}

**To reproduce**

${description.how_to_reproduce}

**Expected**

${description.expected}

\`src/clamp.js:3\` at deadbee:

\`\`\`
3| if (v > hi) return v;
\`\`\`

Not yet reproduced by a test.

<sub>perch abcd1234</sub>`);
    noModelTalk(body);
    expect(marker(finding)).toBe('perch abcd1234');
  });

  it('updates an issue that already carries the marker instead of filing twice, and leaves a closed one alone', async () => {
    const calls = [];
    const listed = JSON.stringify([{ url: 'https://github.com/o/r/issues/3', state: 'OPEN', body: `stuff\n\n<sub>${marker(finding)}</sub>` }]);
    const run = async args => { calls.push(args); if (args[1] === 'create') throw new Error('should not create'); return args[1] === 'list' ? listed : ''; };
    const published = await publishIssue({ finding, github, run });
    expect(published).toMatchObject({ github_url: 'https://github.com/o/r/issues/3', github_status: 'updated' });
    expect(calls[1].slice(0, 5)).toEqual(['issue', 'edit', 'https://github.com/o/r/issues/3', '-R', 'o/r']);
    const closed = JSON.stringify([{ url: 'https://github.com/o/r/issues/3', state: 'CLOSED', body: `<sub>${marker(finding)}</sub>` }]);
    expect(await publishIssue({ finding, github, run: async args => (args[1] === 'list' ? closed : (() => { throw new Error('no edits'); })()) })).toMatchObject({ github_status: 'closed' });
    // Without a description nothing can be filed, but a known issue is simply kept.
    expect(await publishIssue({ finding: { ...bare, github_url: 'https://github.com/o/r/issues/3' }, github, run: async () => { throw new Error('no calls'); } })).toMatchObject({ github_url: 'https://github.com/o/r/issues/3' });
    await expect(publishIssue({ finding: bare, github, run: async () => '[]' })).rejects.toThrow('no description');
  });

  it('refuses a finding without a GitHub repository', async () => {
    await expect(publishIssue({ finding, github: null, run: async () => '' })).rejects.toThrow('no GitHub repository');
    await expect(publishFinding({ finding, github: null, root: '/x', out: '/x/.perch', run: async () => '' })).rejects.toThrow('no GitHub repository');
  });

  it('closes the issue of a discarded finding with the reason, and does nothing without one', async () => {
    const discarded = { ...bare, fix: { id: 'f1', status: 'rejected', attempts: 3, error: 'the test passes on the original, so it does not demonstrate the defect:\n...' } };
    expect(await publishFinding({ finding: discarded, github, run: async () => { throw new Error('no calls'); } })).toMatchObject({ github_status: 'discarded' });
    const calls = [];
    const closed = await discardFinding({ finding: { ...discarded, github_url: 'https://github.com/o/r/issues/7' }, github, run: async args => { calls.push(args); return ''; } });
    expect(closed.github_status).toBe('closed');
    expect(calls[0].slice(0, 4)).toEqual(['issue', 'close', 'https://github.com/o/r/issues/7', '-R']);
    expect(calls[0].at(-1)).toBe('Could not reproduce this. 3 attempts to write a test that fails on the current code and passes on a fix all fell through; the last one: the test passes on the original, so it does not demonstrate the defect:.\n\nClosing as not reproduced.\n\n<sub>perch abcd1234</sub>');
    expect(await discardFinding({ finding: closed, github, run: async () => { throw new Error('no calls'); } })).toBe(closed);
    expect(formatPublished(closed)).toBe('abcd1234  discarded: no fix could be proven; closed https://github.com/o/r/issues/7');
  });

  it('writes the finding up before filing when it has no description yet', async () => {
    const calls = [];
    const run = async args => { calls.push(args); return args[1] === 'list' ? '[]' : 'https://github.com/o/r/issues/8\n'; };
    const described = [];
    const describe = async options => { described.push(options); return description; };
    const published = await publishFinding({ finding: bare, github, root: '/repo', out: '/repo/.perch', model: () => 'lazy-model', analyzer: 'analyzer', run, describe });
    expect(described).toHaveLength(1);
    expect(described[0]).toMatchObject({ finding: bare, root: '/repo', out: '/repo/.perch', model: 'lazy-model', analyzer: 'analyzer' });
    expect(published).toMatchObject({ github_url: 'https://github.com/o/r/issues/8', github_status: 'created', description });
    expect(calls[1][calls[1].indexOf('--title') + 1]).toBe(description.title);
    // With a description already recorded, no write-up is requested.
    await publishFinding({ finding: { ...finding, github_url: 'https://github.com/o/r/issues/8' }, github, root: '/repo', out: '/repo/.perch', run, describe: async () => { throw new Error('no write-up'); } });
  });

  it('opens a pull request for a proven fix: a branch from the finding\'s commit with the patch and test, pushed to origin, closing the issue', async () => {
    const root = await makeFixture();
    cleanups.push(root);
    const origin = await mkdtemp(join(tmpdir(), 'perch-origin-'));
    cleanups.push(origin);
    await git(['init', '-q', '--bare', origin]);
    await git(['remote', 'add', 'origin', origin], root);
    const repo = { root, revision: await revision(root), out: join(root, '.perch') };
    const analyzer = createSourceAnalyzer();
    const hunt = await runHunt(fixtureOptions(repo, { analyzer, systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.9, where: 'L0003', kind_wrong_return: 0.9 } }) }));
    const fix = await runFix({ finding: hunt.visited[0], root, out: repo.out, analyzer, shell: createShell(), systemOne: scriptedSystemOne(), model: scriptedModel() });
    expect(fix.status).toBe('ready');
    const store = openStore(repo.out);
    const [proven] = await store.findings();
    expect(proven.fix.status).toBe('ready');

    // The write-up is asked for with the method, the flagged line, the callers, and the proven patch in front of the model.
    const writer = scriptedModel();
    const written = await describeFinding({ finding: proven, root, out: repo.out, analyzer, model: writer });
    expect(written).toEqual(description);
    const prompt = writer.calls[0].prompt;
    expect(writer.calls[0].id).toBe('describe');
    expect(prompt).toContain('FLAGGED LINE 3: if (v > hi) return v;');
    expect(prompt).toContain('THE FIX, already proven by test/clamp.test.js');
    expect(prompt).toContain('+  if (v > hi) return hi;');
    expect(prompt).toContain('export function clamp(v, lo, hi) {');
    expect(prompt).toContain('"called_by"');

    const calls = [];
    const run = async args => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/9\n';
      if (args[0] === 'pr' && args[1] === 'list') return '[]';
      if (args[0] === 'repo') return 'main\n';
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/o/r/pull/10\n';
      throw new Error(`unexpected gh ${args.join(' ')}`);
    };
    const published = await publishFinding({ finding: proven, github, root, out: repo.out, model: scriptedModel(), analyzer, run });
    expect(published).toMatchObject({ github_url: 'https://github.com/o/r/issues/9', github_status: 'created', pr_url: 'https://github.com/o/r/pull/10', pr_status: 'created', description });
    expect(calls.map(args => args.slice(0, 2).join(' '))).toEqual(['issue list', 'issue create', 'pr list', 'repo view', 'pr create']);
    expect(calls[3]).toEqual(['repo', 'view', 'o/r', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name']);
    const issue = calls[1][calls[1].indexOf('--body') + 1];
    expect(issue).toContain(`**Fix**: ${description.what_changed} A new case in \`test/clamp.test.js\` fails before the change and passes after it; pull request to follow.`);
    noModelTalk(issue);
    const create = calls[4];
    expect(create.slice(2, 8)).toEqual(['-R', 'o/r', '--head', branchFor(proven), '--base', 'main']);
    expect(create[create.indexOf('--title') + 1]).toBe(description.title);
    const body = create[create.indexOf('--body') + 1];
    expect(body).toBe(pullRequestBody({ ...published }));
    expect(body).toBe(`${description.what_happens}

**What changed**

${description.what_changed}

**Testing**

A new case in \`test/clamp.test.js\` fails on the current code and passes with this change.

Closes #9

<sub>perch ${proven.id} · fix ${fix.id.slice(0, 8)}</sub>`);
    noModelTalk(body);
    expect(pullRequestTitle(published)).toBe(description.title);

    // The branch on origin has exactly one commit over the finding's revision, carrying the fixed method and the extended test; the checkout carries the fix commit.
    const branch = branchFor(proven);
    expect((await git(['rev-parse', `${branch}~1`], origin)).trim()).toBe(repo.revision);
    expect((await git(['show', `${branch}:src/clamp.js`], origin))).toContain('if (v > hi) return hi;');
    expect((await git(['show', `${branch}:test/clamp.test.js`], origin))).toBe(regressionSource);
    expect((await git(['log', '-1', '--format=%s', branch], origin)).trim()).toBe(description.title);
    expect((await git(['log', '-1', '--format=%b', branch], origin))).not.toContain('<sub>');
    expect(await readFile(join(root, 'src', 'clamp.js'), 'utf8')).toBe(fixedSource);
    expect((await git(['status', '--porcelain'], root)).trim()).toBe('');
    expect(existsSync(join(repo.out, 'workspaces', `pr-${fix.id}`))).toBe(false);
    expect(formatPublished(published)).toBe(`${proven.id}  ${description.title}\n${proven.id}  issue: https://github.com/o/r/issues/9  (created)\n${proven.id}  pull request: https://github.com/o/r/pull/10  (created)`);

    // Recorded, the finding shows its write-up, issue, and pull request; publishing again refreshes both rather than duplicating.
    await store.appendEvent({ type: 'published', at: new Date().toISOString(), id: proven.id, method: proven.method, github_url: published.github_url, github_status: published.github_status, pr_url: published.pr_url, pr_status: published.pr_status, description: published.description });
    const [recorded] = await store.findings();
    expect(recorded).toMatchObject({ github_url: 'https://github.com/o/r/issues/9', github_status: 'created', pr_url: 'https://github.com/o/r/pull/10', description });
    expect(formatFinding(recorded)).toContain('Status: open  PR: https://github.com/o/r/pull/10');
    expect(formatFinding(recorded)).toContain(`Filed as: ${description.title}`);
    expect(formatIssues([recorded], 0.5)).toMatch(/open +#10/);
    expect(formatIssues([recorded], 0.5)).toContain('Status');
    expect(formatIssues([recorded], 0.5)).not.toMatch(/proven|discarded|Fixed/);
    const edits = [];
    const again = await publishFinding({ finding: recorded, github, root, out: repo.out, run: async args => { edits.push(args.slice(0, 2).join(' ')); return ''; }, describe: async () => { throw new Error('no write-up'); } });
    expect(edits).toEqual(['issue edit', 'pr edit']);
    expect(again).toMatchObject({ github_status: 'updated', pr_status: 'updated' });
    const reuse = await openPullRequest({ finding: { ...recorded, pr_url: undefined }, root, out: repo.out, github, run: async args => (args[1] === 'list' ? JSON.stringify([{ url: 'https://github.com/o/r/pull/10' }]) : '') });
    expect(reuse).toMatchObject({ pr_url: 'https://github.com/o/r/pull/10', pr_status: 'updated' });
    await expect(openPullRequest({ finding, root, out: repo.out, github, run: async () => '' })).rejects.toThrow('no proven fix');
  }, 30_000);
});
