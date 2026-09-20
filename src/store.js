/** Results directory layout: what a scan found, what it did, and what you set aside, under one --out directory. */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { git, repoRoot } from './git.js';
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

/** Lines of a broken rule's unit worth printing; past this it is a file to open, not a thing to read in a terminal. */
const SOURCE_LINES = 40;
/**
 * What you have closed, and what that covers. Closing an issue is you saying perch was wrong about this, or that you know and are
 * not changing it, and neither stops being true because the code around it moved, so a closure holds until you take it back.
 *
 * It covers the kinds that were on the issue when you closed it and nothing else. Closing a method for being undocumented is not
 * a promise that nothing will ever be wrong with it, so a defect that turns up in it later is a new thing and is listed.
 */
function closures(events) {
  const byId = new Map();
  for (const event of events) {
    const held = byId.get(event.id) ?? { kinds: new Set(), at: null, reason: null };
    if (event.type === 'dismissed') Object.assign(held, { at: event.at, reason: event.reason ?? null });
    for (const kind of event.kinds ?? []) { if (event.type === 'dismissed') held.kinds.add(kind); else held.kinds.delete(kind); }
    // Reopening without naming a kind takes the whole thing back.
    if (event.type === 'reopened' && !event.kinds?.length) held.kinds.clear();
    byId.set(event.id, held);
  }
  return byId;
}
const byCreation = (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id);
/** Ranked on the worst thing alone. `issuesOf` hands them back strongest first, so the head is that, and a method with one
 * thing at 90% belongs above a method with five at 60%. */
const surest = (finding, min) => issuesOf(finding, min)[0]?.probability ?? 0;

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
    runDir: id => join(out, 'runs', id),
    /** Ignore cached results inside the repository while allowing closed.jsonl to be committed. */
    async exclude(root) {
      if (!out.startsWith(root + '/')) return;
      const path = join(out, '.gitignore');
      const wanted = '# Written by perch. Results are a cache; closures are not.\n*\n!closed.jsonl\n';
      if (await readFile(path, 'utf8').catch(() => null) === wanted) return;
      await mkdir(out, { recursive: true });
      await writeFile(path, wanted);
    },
    /**
     * What the last scan found, rewritten whole every time. Nothing here is a cache of a model answer: a scan asks every question
     * of everything it covers, so what is on disk is what that run said and nothing older is hiding behind it.
     *
     * What you decided is kept apart. A dismissal is a judgement you made and has to survive the next run; an answer does not.
     */
    scanPath: join(out, 'scan.jsonl'),
    closedPath: join(out, 'closed.jsonl'),
    /** Everything the last run did, written whether or not anyone asked to watch it, which is when you want it. */
    logPath: join(out, 'scan.log'),
    async startLog() {
      await mkdir(out, { recursive: true });
      await writeFile(store.logPath, `${new Date().toISOString()} perch\n`);
      return line => appendFile(store.logPath, `${new Date().toISOString()} ${line}\n`).catch(() => {});
    },
    /** Enough of the end to show what a run was doing when it stopped, which is what doctor prints when one did not finish. */
    async tail(count = 20) {
      const text = await readFile(store.logPath, 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).slice(-count);
    },
    async readLines(path) {
      const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    async writeLines(path, rows) {
      // Written beside and moved into place, the way writeJson does. A crash partway through a direct write leaves the file every
      // command reads truncated at whatever line it reached, which reads as a scan that found less rather than as a broken file.
      await mkdir(out, { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
      await rename(tmp, path);
    },
    /** What the last scan read, every rule it checked, and what you have set aside. */
    async indexes() {
      const latest = new Map(), checks = new Map();
      for (const event of await store.readLines(store.scanPath)) {
        // A method reading is keyed by its method so the scan's own list can join to it. A rule checked against a file may be
        // about a file with no methods at all, so it is keyed by its own id and stands on its own.
        if (event.rule) checks.set(event.id, event);
        else if (event.id && event.answers_set) latest.set(event.method, event);
      }
      return { latest, dismissals: closures(await store.readLines(store.closedPath)), checks };
    },
    /** One scan's findings, replacing the last scan's. */
    recordScan(findings) { return store.writeLines(store.scanPath, findings); },
    /**
     * Set a finding aside, or put it back. Appended, since it is a decision and the next run must still see it. `kinds` says what
     * the closure covers; left out, it covers what the issue carries now, which is what you were looking at when you closed it.
     */
    async decide(type, finding, { kinds = null, reason = null } = {}) {
      // Closing without naming kinds covers what the issue was listing, at the floors a listing reads. Not everything the answers
      // hold: a one-line function listed for a 67% comment carries a 10% buffer overflow as well, and closing the comment used to
      // set that aside too, so a real one arriving later would never be shown. Reopening without naming them takes the whole
      // thing back, so it names none: the kinds it would otherwise list are the live ones, which were never closed.
      const covers = type === 'dismissed' ? { kinds: kinds ?? issuesOf(finding, BELIEVED).map(issue => issue.label), reason } : kinds ? { kinds } : {};
      const event = { type, at: new Date().toISOString(), id: finding.id, method: finding.method ?? null, path: finding.path, name: finding.name, line: finding.line, ...covers };
      await mkdir(out, { recursive: true });
      await appendFile(store.closedPath, JSON.stringify(event) + '\n');
      return event;
    },
    dismiss(finding, reason, kinds = null) { return store.decide('dismissed', finding, { kinds, reason }); },
    reopen(finding, kinds = null) { return store.decide('reopened', finding, { kinds }); },
    /** The latest System One reading of each method. */
    async latestFindings() {
      const { latest } = await store.indexes();
      return [...latest.values()].map(finding => ({ ...finding }));
    },
    /**
     * Every method with an issue at probability `min` or more, strongest first: System One's answers for the methods it has read, joined
     * with the latest scan's metrics for every method, so a method too complex by the metrics is an issue whether or not it was read.
     */
    async issues(min = 0.5, { scan = null, all = false } = {}) {
      const findings = await store.latestFindings();
      const { dismissals, checks } = await store.indexes();
      scan ??= await store.latestScan();
      const byMethod = new Map(findings.map(finding => [finding.method, finding]));
      const every = [];
      if (scan) {
        const seen = new Set();
        for (const file of scan.files ?? []) {
          if (file.test) continue;
          for (const method of file.methods) {
            seen.add(method.id);
            const reading = byMethod.get(method.id);
            const base = { metrics: method.metrics, file: file.metrics };
            // Answers about a method that has since changed are stale; the metrics are always about the code as it is.
            every.push(reading && reading.hash === method.hash ? { ...reading, ...base } : { id: findingId(method.id), method: method.id, path: file.path, name: method.qualified_name, line: method.line, end_line: method.end_line, hash: method.hash, revision: scan.revision, root: scan.root, at: scan.created_at, unread: true, ...base });
          }
        }
        for (const finding of findings) if (!seen.has(finding.method)) every.push(finding);
      } else every.push(...findings);
      // Listed when the scan believes at least one thing about the method, ranked by what its problems are expected to cost.
      // The ranking counts every answer at its probability, so a method kept for one issue at 80% still sorts on all of them.
      // A rule checked against a file is its own finding: it may be about a file with no methods at all, so it does not join
      // the scan's list. One that passed carries nothing to report and falls out below with everything else that is quiet.
      for (const event of checks.values()) every.push({ ...event, lint: { rule: event.rule, broken: event.broken, text: event.text ?? null, said: event.said ?? null } });
      return every.map(finding => {
        const held = dismissals.get(finding.id);
        if (!held?.kinds.size) return finding;
        const closed = { kinds: [...held.kinds], at: held.at, reason: held.reason };
        // Closed when nothing is left live on it, and still listed by `perch issues --closed` either way, which is why what it
        // is kept for is counted without the closure rather than with it.
        return { ...finding, closed, ...(issuesOf({ ...finding, closed }, min).length ? {} : { dismissed: { at: held.at, reason: held.reason } }) };
      // Surest first. What a method's worst problem is likeliest to be is the thing a list is read for; expected cost breaks the
      // tie, so two methods perch is equally sure about are ordered by what they would cost.
      }).filter(event => all || issuesOf({ ...event, closed: null }, min).length).sort((a, b) => surest(b, min) - surest(a, min) || issueWeight(b) - issueWeight(a));
    },
    /** Flagged methods at probability `min` or more, most likely first. */
    async findings(min = BELIEVED) {
      // Judged at the same threshold the list was built with. Left to its own default it judges at zero, which since --min 0
      // means every floor is off would call a defect at 0.3 a finding.
      return (await store.issues(min)).filter(event => flagged(event, min)).sort((a, b) => surest(b, min) - surest(a, min) || issueWeight(b) - issueWeight(a));
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
      const root = (await store.listRuns()).at(-1)?.root;
      if (!root) return findings;
      const blobs = new Map();
      // A blob that is not at that revision is an ordinary absence: the file was added since, or renamed. Anything else is git
      // failing, and a finding printed without the code it is about is worth less than knowing why.
      const linesOf = async finding => {
        const key = `${finding.revision}:${finding.path}`;
        if (!blobs.has(key)) {
          const lines = await git(['show', key], root).then(text => text.split('\n'))
            .catch(error => { if (/does not exist|unknown revision|no such path/i.test(error.message)) return null; throw error; });
          blobs.set(key, lines);
        }
        return blobs.get(key);
      };
      for (const finding of findings) {
        // A broken rule is read by deciding whether to change the code, so the code it was asked about comes with it.
        if (finding.lint && !finding.lint.source) {
          const lines = (await linesOf(finding)) ?? [];
          const from = finding.line ?? 1, to = Math.min(finding.end_line ?? from, from + SOURCE_LINES - 1);
          finding.lint.source = lines.slice(from - 1, to).map((text, index) => `${String(from + index).padStart(5)}| ${text}`).join('\n');
          finding.lint.more = Math.max(0, (finding.end_line ?? from) - to);
        }
        if (finding.where?.text !== undefined || !finding.where?.line) continue;
        finding.where.text = (await linesOf(finding))?.[finding.where.line - 1]?.trim() ?? '';
      }
      return findings;
    },
    listRuns: () => records('runs', 'run.json'),
    listScans: () => records('scans', 'scan.json'),
    async latestRun() { return (await store.listRuns()).at(-1) ?? null; },
    /**
     * The tree an issue list is joined against, so a method this does not hold is a method that is gone. Scans are read in the
     * order they were made, which is what makes the last one the current one.
     */
    async latestScan() { return (await store.listScans()).at(-1) ?? null; },
  };
  return store;
}
