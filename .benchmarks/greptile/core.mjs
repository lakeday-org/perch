import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export const CUTOFFS = [0.6, 0.7, 0.8];
/** The saved runs, in the order they are printed. */
export const CONFIGS = {
  oai2q: 'perch#418, OpenAI Decisions',
  oai407: 'perch#407, OpenAI Decisions',
  jev: 'perch 0.4.7, Jev',
  oai: 'perch 0.4.7, OpenAI Decisions',
};

export async function jsonl(file) {
  const data = await fs.readFile(file);
  return (file.endsWith('.gz') ? gunzipSync(data) : data).toString().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** The answers a reading carries that the score reads: the two bug questions, and the review_ questions perch#407 asked. */
export const answersOf = row => Object.fromEntries(Object.entries(row)
  .filter(([key, value]) => typeof value === 'number' && (key === 'has_bug' || key === 'bug_edge_case' || key.startsWith('review_'))));

/**
 * One pull request's run as a line of results/<config>.jsonl: how the scan ended, what it cost, the methods perch reported, and
 * every method it read with its answers. `dir` holds the run's result.json, and the scan.jsonl and stdout.json that
 * `perch scan --json --out <dir>` left there. A method read twice keeps its last reading.
 */
export async function compact(config, item, dir) {
  const result = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
  const methods = new Map();
  let reported = [], usage = {};
  if ([0, 3].includes(result.code)) {
    for (const line of (await fs.readFile(path.join(dir, 'scan.jsonl'), 'utf8')).split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (row.type === 'read') methods.set(row.method, { method: row.method, ...answersOf(row) });
    }
    const json = JSON.parse(await fs.readFile(path.join(dir, 'stdout.json'), 'utf8'));
    reported = [...new Set((json.issues ?? []).map(issue => issue.method))];
    usage = json.usage ?? {};
  }
  return { config, pr: `${item.repo}-${item.pr}`, code: result.code, seconds: result.seconds, usage,
    cost: Object.values(usage).reduce((n, u) => n + (u.cost ?? 0), 0), reported, methods: [...methods.values()] };
}

/** Flagged: any bug question answered strictly above the cutoff. */
export const flagged = (answers, cutoff) => Object.values(answers).some(p => p > cutoff);

/** The middle value, the upper of the two middle ones for an even count. */
export const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };

/** The chance that `flags` methods drawn at random from `read` land on at least one of `buggy` of them. */
export function chance(read, buggy, flags) {
  let miss = 1;
  for (let i = 0; i < flags; i++) miss *= Math.max(0, read - buggy - i) / (read - i);
  return 1 - miss;
}

/**
 * Scores one configuration's runs at one cutoff. `runs` maps `<repo>-<pr>` to a results line, `known` holds each pull request's
 * known bug and `labels` each golden comment, both with the functions they are about.
 *
 * `known` is Greptile's grading: a pull request counts when a flagged function holds its one known bug, out of every pull request,
 * so one whose known bug sits in no function, or whose scan failed, is a miss. `caught` is the looser count over golden comments:
 * a flagged function holding any of them, out of the pull requests that have one inside a function.
 */
export function score(manifest, labels, runs, cutoff, known = []) {
  let read = 0, flags = 0, caught = 0, of = 0, golden = 0, goldenOf = 0, expected = 0, cost = 0, knownCaught = 0, knownExpected = 0;
  const perPr = [], missing = [];
  for (const item of manifest) {
    const name = `${item.repo}-${item.pr}`, run = runs.get(name);
    if (!run || ![0, 3].includes(run.code)) { missing.push(name); continue; }
    const ids = run.methods.map(m => m.method), byId = new Map(run.methods.map(m => [m.method, m]));
    const hits = new Set(ids.filter(id => flagged(answersOf(byId.get(id)), cutoff)));
    read += ids.length; flags += hits.size; perPr.push(hits.size); cost += run.cost;
    const bug = known.find(entry => entry.repo === item.repo && entry.pr === item.pr);
    if (bug?.methods.length) {
      if (bug.methods.some(id => hits.has(id))) knownCaught++;
      knownExpected += chance(ids.length, bug.methods.filter(id => ids.includes(id)).length, hits.size);
    }
    const inside = labels.filter(label => label.repo === item.repo && label.pr === item.pr && label.methods.length);
    if (!inside.length) continue;
    let any = false;
    for (const label of inside) { goldenOf++; if (label.methods.some(id => hits.has(id))) { golden++; any = true; } }
    of++; if (any) caught++;
    const buggy = new Set(inside.flatMap(label => label.methods).filter(id => ids.includes(id)));
    expected += chance(ids.length, buggy.size, hits.size);
  }
  return { cutoff, prs: manifest.length - missing.length, missing, known: knownCaught, known_of: manifest.length, known_chance: +knownExpected.toFixed(1),
    caught, of, chance: +expected.toFixed(1), golden, golden_of: goldenOf,
    flags, read, flag_rate: read ? +(flags / read).toFixed(3) : null, median_flags: median(perPr), cost: +cost.toFixed(3) };
}

/** Each pull request's known bug, from known.json: Greptile's description of it and the functions that hold it. */
export const readKnown = async root => JSON.parse(await fs.readFile(path.join(root, 'known.json'), 'utf8'));

/** Every golden comment's label, from truth/<repo>.json, with its repository. */
export async function readLabels(root, manifest) {
  const repos = [...new Set(manifest.map(item => item.repo))];
  return (await Promise.all(repos.map(async repo => JSON.parse(await fs.readFile(path.join(root, 'truth', `${repo}.json`), 'utf8'))
    .map(label => ({ ...label, repo }))))).flat();
}
