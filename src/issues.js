/** Publish proven issues to GitHub with the gh CLI, once per title. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rename } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

async function gh(args) {
  try { return (await execFileAsync('gh', args, { maxBuffer: 16 * 1024 * 1024 })).stdout; }
  catch (error) { throw new Error(`gh ${args[0]} ${args[1] ?? ''} failed: ${(error.stderr || error.message || '').toString().trim()}`); }
}

export function issueBody(issue) {
  const lines = [
    issue.summary, '',
    `- Priority: ${issue.priority}`, `- File: \`${issue.path}\``, `- Revision: ${issue.revision}`, `- Regression test: \`${issue.regression_path}\``, `- Command: \`${issue.command}\``,
    '', 'Regression test that fails on this revision:', '', '```', issue.regression.trim(), '```',
  ];
  const quote = issue.evidence?.[0]?.quote?.trim();
  if (quote) lines.push('', 'Observed failure:', '', '```', quote.slice(-6000), '```');
  lines.push('', 'Found by perch.');
  return lines.join('\n');
}

/** Create one GitHub issue per proven bug, skipping titles that already have an open issue. */
export async function publishIssues({ github, issues, issuesPath, run = gh, log = () => {} }) {
  const repo = `${github.owner}/${github.repo}`;
  let changed = false;
  for (const issue of issues) {
    if (issue.github_url) { log(`issue already filed: ${issue.github_url}`); continue; }
    const listed = JSON.parse(await run(['issue', 'list', '-R', repo, '--state', 'open', '--search', `${JSON.stringify(issue.title)} in:title`, '--json', 'title,url', '--limit', '50']) || '[]');
    const existing = listed.find(item => item.title === issue.title);
    if (existing) {
      log(`open issue with the same title exists: ${existing.url}`);
      issue.github_url = existing.url;
      issue.github_status = 'existing';
    } else {
      const url = (await run(['issue', 'create', '-R', repo, '--title', issue.title, '--body', issueBody(issue)])).trim().split('\n').at(-1);
      log(`filed ${url}`);
      issue.github_url = url;
      issue.github_status = 'created';
    }
    changed = true;
    if (issuesPath) {
      const tmp = `${issuesPath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(issues, null, 2) + '\n');
      await rename(tmp, issuesPath);
    }
  }
  return changed;
}
