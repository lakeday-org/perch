/** Open a pull request for a proven fix: a branch from the finding's commit carrying the patch and its regression test, pushed to origin, closing the issue. */
import { join } from 'node:path';
import { addWorktree, git, removeWorktree } from './git.js';
import { gh, issueNumber, repoOf } from './gh.js';

export const branchFor = finding => `perch/fix-${finding.id}`;
export const pullRequestTitle = finding => finding.description.title;

export function pullRequestBody(finding) {
  const { fix, description: text } = finding;
  const existing = fix.proof?.existing_tests ?? [];
  const extended = fix.proof?.test_mode === 'extended';
  const lines = [text.what_happens, '', '**What changed**', '', text.what_changed || fix.summary, '', '**Testing**', '',
    `${extended ? `A new case in \`${fix.test_path}\`` : `The new \`${fix.test_path}\``} fails on the current code and passes with this change.`];
  const others = existing.filter(path => path !== fix.test_path);
  if (others.length) lines.push(`The existing tests that reach \`${finding.name}\` still pass: ${others.map(path => `\`${path}\``).join(', ')}.`);
  else if (!extended) lines.push(`No existing test covered \`${finding.name}\`.`);
  if (fix.proof?.baseline_failures?.length) lines.push(`${fix.proof.baseline_failures.map(path => `\`${path}\``).join(', ')} already failed before this change and ${fix.proof.baseline_failures.length === 1 ? 'is' : 'are'} unaffected by it.`);
  const issue = issueNumber(finding.github_url);
  if (issue) lines.push('', `Closes #${issue}`);
  lines.push('', `<sub>perch ${finding.id} · fix ${fix.id.slice(0, 8)}</sub>`);
  return lines.join('\n');
}

/** Returns the finding with its pull request URL: opens one unless the branch already has one open, in which case its text is refreshed. */
export async function openPullRequest({ finding, root, out, github, run = gh, log = () => {} }) {
  if (finding.fix?.status !== 'ready') throw new Error(`finding ${finding.id} has no proven fix to publish; run perch fix first`);
  if (!github) throw new Error(`finding ${finding.id} has no GitHub repository: hunt a GitHub target or a checkout whose origin is on github.com`);
  if (!finding.description) throw new Error(`finding ${finding.id} has no description to publish`);
  const repo = repoOf(github), branch = branchFor(finding), title = pullRequestTitle(finding), body = pullRequestBody(finding);
  let url = finding.pr_url ?? null;
  if (!url) {
    const open = JSON.parse(await run(['pr', 'list', '-R', repo, '--head', branch, '--state', 'open', '--json', 'url', '--limit', '1']) || '[]');
    if (open[0]) { url = open[0].url; log(`open pull request for ${branch} exists: ${url}`); }
  }

  // The branch is built in a worktree of its own at the finding's commit, so the operator's checkout is never touched.
  const dir = join(out, 'workspaces', `pr-${finding.fix.id}`);
  log(`building ${branch} from ${finding.revision.slice(0, 12)}`);
  await addWorktree(root, dir, finding.revision);
  try {
    await git(['checkout', '-q', '-B', branch], dir);
    await git(['apply', '--index', finding.fix.patch_path], dir);
    await git(['commit', '-q', '-m', title, '-m', body.replace(/\n\n<sub>.*<\/sub>$/s, '')], dir);
    log(`pushing ${branch} to origin`);
    await git(['push', '--force', '--quiet', 'origin', `${branch}:refs/heads/${branch}`], dir);
  } finally {
    await removeWorktree(root, dir).catch(() => {});
  }
  if (url) {
    await run(['pr', 'edit', url, '-R', repo, '--title', title, '--body', body]);
    log(`updated ${url}`);
    return { ...finding, pr_url: url, pr_status: 'updated' };
  }
  const base = (await run(['repo', 'view', repo, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'])).trim() || 'main';
  url = (await run(['pr', 'create', '-R', repo, '--head', branch, '--base', base, '--title', title, '--body', body])).trim().split('\n').at(-1);
  log(`opened ${url}`);
  return { ...finding, pr_url: url, pr_status: 'created' };
}
