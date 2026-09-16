/**
 * Publish one finding to GitHub with the gh CLI. A finding without a fix becomes an issue; a finding with a proven fix becomes an issue and a
 * pull request that closes it; a finding whose fix was discarded closes its issue. Every issue and pull request is written from the finding's
 * plain-language description, which the generative model writes from the code (and the fix, when there is one) before anything is filed.
 */
import { gh, repoOf } from './gh.js';
import { openPullRequest } from './pr.js';
import { describeFinding } from './describe.js';

/** The footer every issue and pull request carries, and the string publish searches for to avoid filing twice. */
export const marker = finding => `perch ${finding.id}`;
export const issueTitle = finding => finding.description.title;

export function issueBody(finding) {
  const { description: text, fix } = finding;
  const lines = [text.what_happens];
  if (text.how_to_reproduce) lines.push('', '**To reproduce**', '', text.how_to_reproduce);
  if (text.expected) lines.push('', '**Expected**', '', text.expected);
  lines.push('', `\`${finding.path}:${finding.where.line}\` at ${finding.revision.slice(0, 7)}:`, '', '```', `${finding.where.line}| ${finding.where.text ?? ''}`, '```');
  if (fix?.status === 'ready') lines.push('', `**Fix**: ${text.what_changed || fix.summary} A new case in \`${fix.test_path}\` fails before the change and passes after it; pull request to follow.`);
  else lines.push('', 'Not yet reproduced by a test.');
  lines.push('', `<sub>${marker(finding)}</sub>`);
  return lines.join('\n');
}

/** Returns the finding with its GitHub URL: files the issue unless one already carries this finding's marker, and refreshes the text of one that does. */
export async function publishIssue({ finding, github, run = gh, log = () => {} }) {
  if (!github) throw new Error(`finding ${finding.id} has no GitHub repository: hunt a GitHub target or a checkout whose origin is on github.com`);
  const repo = repoOf(github);
  let url = finding.github_url ?? null, status = finding.github_status ?? 'existing';
  if (!url) {
    const listed = JSON.parse(await run(['issue', 'list', '-R', repo, '--state', 'all', '--search', `"${marker(finding)}" in:body`, '--json', 'url,state,body', '--limit', '20']) || '[]');
    const found = listed.find(item => item.body?.includes(marker(finding)));
    if (found) { url = found.url; status = found.state === 'CLOSED' ? 'closed' : 'existing'; log(`issue with this finding's marker exists: ${url}`); }
  }
  if (!finding.description) {
    if (url) { log(`issue already filed: ${url}`); return finding; }
    throw new Error(`finding ${finding.id} has no description to file`);
  }
  if (url && status === 'closed') { log(`issue already closed: ${url}`); return { ...finding, github_url: url, github_status: status }; }
  if (url) {
    await run(['issue', 'edit', url, '-R', repo, '--title', issueTitle(finding), '--body', issueBody(finding)]);
    log(`updated ${url}`);
    return { ...finding, github_url: url, github_status: 'updated' };
  }
  url = (await run(['issue', 'create', '-R', repo, '--title', issueTitle(finding), '--body', issueBody(finding)])).trim().split('\n').at(-1);
  log(`filed ${url}`);
  return { ...finding, github_url: url, github_status: 'created' };
}

/** The finding's fix was discarded: close its issue with the reason, if one is open. */
export async function discardFinding({ finding, github, run = gh, log = () => {} }) {
  const reason = (finding.fix.error ?? 'no attempt produced a test that fails on this code and passes on a fix').split('\n')[0];
  if (!finding.github_url) { log(`finding ${finding.id} discarded; no issue to close`); return { ...finding, github_status: 'discarded' }; }
  if (finding.github_status === 'closed') { log(`issue already closed: ${finding.github_url}`); return finding; }
  const attempts = finding.fix.attempts ?? 'Several';
  const comment = `Could not reproduce this. ${attempts} attempts to write a test that fails on the current code and passes on a fix all fell through; the last one: ${reason}.\n\nClosing as not reproduced.\n\n<sub>${marker(finding)}</sub>`;
  await run(['issue', 'close', finding.github_url, '-R', repoOf(github), '--comment', comment]);
  log(`closed ${finding.github_url}`);
  return { ...finding, github_status: 'closed' };
}

/**
 * Publish whatever the finding has become: an issue, an issue plus a pull request for its proven fix, or a closed issue for a discarded one.
 * `model` may be a model or a function returning one, so the key is only needed when a description has to be written.
 */
export async function publishFinding({ finding, github, root, out, model, analyzer, run = gh, describe = describeFinding, log = () => {} }) {
  if (finding.fix?.status === 'rejected') return discardFinding({ finding, github, run, log });
  if (!github) throw new Error(`finding ${finding.id} has no GitHub repository: hunt a GitHub target or a checkout whose origin is on github.com`);
  if (!root) throw new Error(`finding ${finding.id} has no repository recorded; hunt again`);
  let described = finding;
  if (!finding.description || (finding.fix?.status === 'ready' && !finding.description.what_changed)) {
    const description = await describe({ finding, root, out, analyzer, model: typeof model === 'function' ? model() : model, log });
    described = { ...finding, description };
  }
  const issued = await publishIssue({ finding: described, github, run, log });
  if (finding.fix?.status !== 'ready') return issued;
  return openPullRequest({ finding: issued, root, out, github, run, log });
}
