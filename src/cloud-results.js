/** Reduce a local scan to the commit and findings the dashboard needs. */
import { readFile } from 'node:fs/promises';
import { CORRECTNESS } from './ask.js';
import { issuesFor, severityBand } from './questions.js';

/**
 * Which commit and branch a scan was of, and whether CI ran it. A pull request job checks out a merge commit nobody pushed, so
 * the pull request's head is reported instead: that is the commit the dashboard and the check run belong to.
 */
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

/**
 * One row per issue a finding shows at this threshold, the same issues perch issues would list. Severity goes only on defects
 * and vulnerabilities, where it means something.
 */
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
    }
  }
  return rows;
}

/** Send findings during the scan. Batches bound each request, never the number of results a scan may report. */
export function createResultStream(client, scan) {
  const seen = new Set(), buffered = [], queued = [], waiting = [];
  let remote = null, failure = null, active = 0, timer = null, progressTimer = null, latestProgress = null, progressTask = null;
  let lastProgress = { phase: 'preparing', completed: 0, total: 0, failed: 0 };
  const settle = () => {
    if (!failure && (active || queued.length)) return;
    for (const resolve of waiting.splice(0)) resolve();
  };
  const pump = () => {
    if (!remote || failure) return;
    while (active < 4 && queued.length) {
      const rows = queued.shift();
      active++;
      client.appendFindings(remote.id, rows).catch(error => { failure ??= error; }).finally(() => {
        active--;
        pump();
        settle();
      });
    }
    settle();
  };
  const begin = client.startScan(scan).then(saved => { remote = saved; pump(); }, error => { failure = error; settle(); });
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    while (buffered.length) {
      const rows = [];
      let bytes = 0;
      while (buffered.length && rows.length < 80) {
        const next = buffered[0], size = Buffer.byteLength(JSON.stringify(next)) + 1;
        if (rows.length && bytes + size > 24 * 1024) break;
        rows.push(buffered.shift());
        bytes += size;
      }
      queued.push(rows);
    }
    pump();
  };
  const sendProgress = () => {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = null;
    if (progressTask || !latestProgress) return;
    const current = latestProgress;
    latestProgress = null;
    progressTask = (async () => {
      await begin;
      if (remote && client.updateScan) await client.updateScan(remote.id, current);
    })().catch(() => { /* The result batches and final report still decide whether upload succeeded. */ })
      .finally(() => {
        progressTask = null;
        if (latestProgress) sendProgress();
      });
  };
  const finishProgress = async () => {
    sendProgress();
    if (!progressTask) return;
    await progressTask;
    if (progressTask || latestProgress) await finishProgress();
  };
  const heartbeat = setInterval(() => { latestProgress = lastProgress; sendProgress(); }, 30_000);
  heartbeat.unref?.();
  return {
    add(rows) {
      for (const row of rows) {
        const key = `${row.id}\u0000${row.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        buffered.push(row);
      }
      if (buffered.length && !timer) timer = setTimeout(flush, 100);
    },
    progress(value) {
      latestProgress = lastProgress = value;
      if (!progressTimer) progressTimer = setTimeout(sendProgress, 750);
    },
    async finish(finalScan) {
      clearInterval(heartbeat);
      flush();
      await finishProgress();
      await begin;
      if (failure) throw failure;
      if (active || queued.length) await new Promise(resolve => waiting.push(resolve));
      if (failure) throw failure;
      return client.finishScan(remote.id, finalScan);
    },
  };
}
