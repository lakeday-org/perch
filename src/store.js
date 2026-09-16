/** Results directory layout: scans, hunts, issues, and fixes as JSON records under one --out directory. */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { excludeFromStatus, git, repoRoot } from './git.js';
import { flagged, hasIssue, issuesOf } from './questions.js';

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
    /**
     * The latest hunted event per method, carrying the most recent fix and refactor made while the method still read as hunted.
     * Events from before findings had ids and per-kind answers are ignored.
     */
    async latestFindings() {
      const latest = new Map(), fixes = new Map(), refactors = new Map();
      for (const event of await store.readEvents()) {
        if (event.type === 'hunted' && event.id && event.kinds) latest.set(event.method, event);
        else if (event.type === 'fixed') fixes.set(event.method, event);
        else if (event.type === 'refactored') refactors.set(event.method, event);
      }
      // A fix or refactor counts for a finding when the method read the same when it was made as when it was hunted.
      const applies = (work, finding) => work && (work.hash ? work.hash === finding.hash : work.revision === finding.revision || work.at >= finding.at);
      const summarize = (work, key) => (work.status === 'ready'
        ? { id: work[key], status: 'ready', at: work.at, summary: work.summary, commit: work.commit ?? null, branch: work.branch ?? null, patch_path: work.patch_path, before: work.before ?? null, after: work.after ?? null, file_before: work.file_before ?? null, file_after: work.file_after ?? null, verification: work.verification, proof: work.proof ?? null }
        : work.status === 'closed' ? { id: work[key], status: 'closed', at: work.at, reason: work.reason }
        : { id: work[key], status: 'rejected', at: work.at, attempts: work.attempts, error: work.error });
      return [...latest.values()].map(finding => {
        const fix = fixes.get(finding.method), refactor = refactors.get(finding.method);
        const merged = { ...finding };
        if (applies(fix, finding)) merged.fix = summarize(fix, 'fix_id');
        if (applies(refactor, finding)) merged.refactored = summarize(refactor, 'refactor_id');
        return merged;
      });
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
            every.push(hunted && hunted.hash === method.hash ? { ...hunted, ...base } : { id: findingId(method.id), method: method.id, path: file.path, name: method.qualified_name, line: method.line, end_line: method.end_line, hash: method.hash, revision: scan.revision, root: scan.root, at: scan.created_at, unread: true, ...base, ...(hunted ? { fix: hunted.fix, refactored: hunted.refactored } : {}) });
          }
        }
        for (const finding of findings) if (!seen.has(finding.method)) every.push(finding);
      } else every.push(...findings);
      const strength = event => issuesOf(event, min)[0]?.probability ?? 0;
      return every.filter(event => all || hasIssue(event, min)).sort((a, b) => strength(b) - strength(a) || (b.severity?.score ?? 0) - (a.severity?.score ?? 0));
    },
    /** Flagged methods at probability `min` or more, most likely first. */
    async findings(min = 0.5) {
      return (await store.issues(min)).filter(event => flagged(event, min)).sort((a, b) => b.has_bug - a.has_bug || (b.severity?.score ?? 0) - (a.severity?.score ?? 0));
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
    listRefactors: () => records('refactors', 'refactor.json'),
    async latestHunt() { return (await store.listHunts()).at(-1) ?? null; },
    /** The most recent scan on disk: the code as it was last analyzed. */
    async latestScan() { return (await store.listScans()).at(-1) ?? null; },
  };
  return store;
}
