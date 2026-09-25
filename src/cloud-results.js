/** Reduce a local scan to the commit and findings the dashboard needs. */
import { readFile } from 'node:fs/promises';
import { CORRECTNESS } from './ask.js';
import { issuesFor, severityBand } from './questions.js';

export async function runContext(env, revision, localBranch = null) {
  const source = env.CI || env.GITHUB_ACTIONS ? 'ci' : 'cli';
  let head = null;
  let pull = null;

  // A pull request checkout is a merge commit. Report the PR's head instead.
  if (env.GITHUB_EVENT_PATH && /^pull_request/.test(env.GITHUB_EVENT_NAME || '')) {
    try {
      const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
      head = event.pull_request?.head?.sha ?? null;
      pull = event.pull_request?.number ?? null;
    } catch { /* The checkout revision is still usable when the event file is missing. */ }
  }

  return {
    source,
    revision: head || revision || null,
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || localBranch || null,
    pull_request: pull,
  };
}

export function reportFindings(findings, min) {
  const rows = [];
  const seen = new Set();

  for (const finding of findings) {
    for (const issue of issuesFor(finding, min)) {
      const kind = String(issue.label);
      const key = `${finding.id}\u0000${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const severity = severityBand(finding.severity);
      rows.push({
        id: finding.id,
        path: finding.path,
        method: finding.method ?? `${finding.path}::${finding.name}`,
        line: finding.line ?? null,
        type: issue.type,
        kind,
        probability: Math.round(issue.probability * 1000) / 1000,
        severity: CORRECTNESS.has(issue.type) && /^P[0-3]$/.test(severity) ? severity : null,
      });
      if (rows.length === 2000) return rows;
    }
  }
  return rows;
}
