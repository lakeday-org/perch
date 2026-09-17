/** Results directory layout: scans, hunts, issues, and fixes as JSON records under one --out directory. */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { excludeFromStatus, git, repoRoot } from './git.js';
import { BELIEVED, flagged, issuesOf, issueWeight } from './questions.js';

export const sha256 = text => createHash('sha256').update(text).digest('hex');
/** A stable 16-hex-character id derived from everything that determines a record's result. */
export const identity = (...parts) => sha256(JSON.stringify(parts)).slice(0, 16);
/** A short stable handle for a method's finding, the same across scans. */
export const findingId = method => identity('finding', method).slice(0, 8);

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, path);
}

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

/** The results directory: --out, else .perch under the enclosing git root (or the working directory). */
export async function resolveOut(out, cwd = process.cwd()) {
  if (out) return resolve(cwd, out);
  return join(await repoRoot(cwd).catch(() => cwd), '.perch');
}

async function entries(dir) {
  try { return await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/** A fix counts for a finding when the method read the same when it was made as when it was read by System One. */
/**
 * Whether a recorded fix still describes this method: the code it was about, or, for one that landed, the code it produced.
 * Anything else means the method has moved on since, and it is workable again.
 */
const fixApplies = (fix, finding) => {
  if (!fix) return false;
  if (fix.status === 'ready' && fix.hash_after === finding.hash) return true;
  return fix.hash ? fix.hash === finding.hash : fix.revision === finding.revision || fix.at >= finding.at;
};
const summarizeFix = work => ({ id: work.fix_id, status: work.status, notes: work.notes ?? null, at: work.at, summary: work.summary ?? null, commit: work.commit ?? null, branch: work.branch ?? null, patch_path: work.patch_path ?? null, before: work.before ?? null, after: work.after ?? null, reason: work.reason ?? null, error: work.error ?? null, attempts: work.attempts ?? 0 });

const byCreation = (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id);

export function openStore(out) {
  const records = async (kind, file) => {
    const list = [];
    for (const entry of await entries(join(out, kind))) {
      const record = entry.isDirectory() ? await readJson(join(out, kind, entry.name, file), null) : null;
      if (record) list.push(record);
    }
    return list.sort(byCreation);
  };
  const store = {
    out,
    scanDir: id => join(out, 'scans', id),
    huntDir: id => join(out, 'hunts', id),
    fixDir: id => join(out, 'fixes', id),
    refactorDir: id => join(out, 'refactors', id),
    /** Keep results out of `git status` when they live inside the repository. */
    async exclude(root) {
      if (out.startsWith(root + '/')) await excludeFromStatus(root, '/' + out.slice(root.length + 1).split('/')[0] + '/');
    },
    eventsPath: join(out, 'events.jsonl'),
    /** Append one event to the log that every hunt reads first. */
    async appendEvent(event) {
      await mkdir(out, { recursive: true });
      await appendFile(store.eventsPath, JSON.stringify(event) + '\n');
    },
    async readEvents() {
      const text = await readFile(store.eventsPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    /** The latest hunted event and the latest fixed event per method. Events from before findings had ids and per-kind answers are ignored. */
    async indexes() {
      const latest = new Map(), fixes = new Map();
      for (const event of await store.readEvents()) {
        if (event.type === 'hunted' && event.id && event.kinds) latest.set(event.method, event);
        else if (event.type === 'fixed') fixes.set(event.method, event);
      }
      return { latest, fixes };
    },
    /** The latest System One reading of each method, carrying the fix made while it still read that way. */
    async latestFindings() {
      const { latest, fixes } = await store.indexes();
      return [...latest.values()].map(finding => { const fix = fixes.get(finding.method); return fixApplies(fix, finding) ? { ...finding, fix: summarizeFix(fix) } : { ...finding }; });
    },
    /** The hash each method had when it was last hunted in the current format. */
    async huntedIndex() {
      const index = new Map();
      for (const event of await store.latestFindings()) index.set(event.method, event.hash);
      return index;
    },
    /**
     * Every method with an issue at probability `min` or more, strongest first: System One's answers for the methods it has read, joined
     * with the latest scan's metrics for every method, so a method too complex by the metrics is an issue whether or not it was read.
     */
    async issues(min = 0.5, { scan = null, all = false } = {}) {
      const findings = await store.latestFindings();
      const { fixes } = await store.indexes();
      scan ??= await store.latestScan();
      const byMethod = new Map(findings.map(finding => [finding.method, finding]));
      const every = [];
      if (scan) {
        const seen = new Set();
        for (const file of scan.files ?? []) {
          if (file.test) continue;
          for (const method of file.methods) {
            seen.add(method.id);
            const hunted = byMethod.get(method.id);
            const base = { metrics: method.metrics, file: file.metrics };
            // Answers about a method that has since changed are stale; the metrics are always about the code as it is.
            const fix = fixes.get(method.id);
            every.push(hunted && hunted.hash === method.hash ? { ...hunted, ...base, ...(fixApplies(fix, method) ? { fix: summarizeFix(fix) } : {}) } : { id: findingId(method.id), method: method.id, path: file.path, name: method.qualified_name, line: method.line, end_line: method.end_line, hash: method.hash, revision: scan.revision, root: scan.root, at: scan.created_at, unread: true, ...base, ...(fixApplies(fix, method) ? { fix: summarizeFix(fix) } : {}) });
          }
        }
        for (const finding of findings) if (!seen.has(finding.method)) every.push(finding);
      } else every.push(...findings);
      // Listed when the scan believes at least one thing about the method, ranked by what its problems are expected to cost.
      // The ranking counts every answer at its probability, so a method kept for one issue at 80% still sorts on all of them.
      return every.filter(event => all || issuesOf(event, min).length).sort((a, b) => issueWeight(b) - issueWeight(a));
    },
    /** Flagged methods at probability `min` or more, most likely first. */
    async findings(min = BELIEVED) {
      return (await store.issues(min)).filter(event => flagged(event)).sort((a, b) => issueWeight(b) - issueWeight(a));
    },
    /** The finding with this id or unique id prefix. */
    async findFinding(ref) {
      const matches = (await store.issues(0.5, { all: true })).filter(event => event.id?.startsWith(ref));
      if (matches.length === 1) return matches[0];
      if (matches.length) throw new Error(`finding id ${ref} is ambiguous: ${matches.map(event => event.id).join(', ')}`);
      throw new Error(`no finding ${ref}; run perch issues to list them`);
    },
    /** Fill in the pointed-at source line for findings recorded without one, reading it from git at their commit. */
    async withSourceLines(findings) {
      const root = (await store.listHunts()).at(-1)?.root;
      if (!root) return findings;
      const blobs = new Map();
      for (const finding of findings) {
        if (finding.where?.text !== undefined || !finding.where?.line) continue;
        const key = `${finding.revision}:${finding.path}`;
        if (!blobs.has(key)) blobs.set(key, await git(['show', key], root).then(text => text.split('\n')).catch(() => null));
        finding.where.text = blobs.get(key)?.[finding.where.line - 1]?.trim() ?? '';
      }
      return findings;
    },
    listHunts: () => records('hunts', 'hunt.json'),
    listScans: () => records('scans', 'scan.json'),
    listFixes: () => records('fixes', 'fix.json'),
    async latestHunt() { return (await store.listHunts()).at(-1) ?? null; },
    /** The most recent scan on disk: the code as it was last analyzed. */
    async latestScan() { return (await store.listScans()).at(-1) ?? null; },
  };
  return store;
}
