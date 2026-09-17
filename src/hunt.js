/** `perch hunt`: walk the method graph from riskiest to least, asking a System One model about each method once. */
import { join } from 'node:path';
import { readBlob } from './git.js';
import { analyzeTree } from './scan.js';
import { buildGraph } from './graph.js';
import { huntSteps, locateWhere, readAnswers } from './questions.js';
import { findingId, identity, openStore, writeJson } from './store.js';
export { findingId };

/** A scan reads every method it has not read before, or whose code changed since. `perch fix` works twenty issues by default. */
export const DEFAULT_FIX_BUDGET = 20, DEFAULT_PARALLEL = 8;

/**
 * What one method's readings say together. The first pass carries the neighbourhood and answers for the method as a whole, so its
 * judgement of shape, documentation and callers stands. A later pass sees only its own slice, so it can only add: the worst defect
 * found anywhere is the method's defect, and a vulnerability is the likeliest reading of it from any pass.
 */
export function mergeAnswers(readings) {
  const merged = { ...readings[0] };
  for (const later of readings.slice(1)) {
    if (later.has_bug > merged.has_bug) Object.assign(merged, { has_bug: later.has_bug, where: later.where, kind: later.kind, kinds: later.kinds, severity: later.severity });
    merged.exposed = Math.max(merged.exposed ?? 0, later.exposed ?? 0);
    merged.securities = Object.fromEntries(Object.entries(merged.securities ?? {}).map(([kind, probability]) => [kind, Math.max(probability, later.securities?.[kind] ?? 0)]));
  }
  const [kind, probability] = Object.entries(merged.securities ?? {}).sort((a, b) => b[1] - a[1])[0] ?? [];
  if (kind) merged.security = { kind, probability };
  if (readings.length > 1) merged.passes = readings.length;
  return merged;
}

/** One System One reading of a method, in as many passes as its length takes, and the line they point at. */
export async function questionMethod({ systemOne, node, step, steps = [step], lines, debug = () => {} }) {
  debug(`asking ${systemOne.id} about ${node.qualified_name} in ${node.path}:${node.line} (${Object.keys(steps[0].questions).length} questions${steps.length > 1 ? ` over ${steps.length} passes` : ''}${steps[0].windows ? `, then a line in the chosen window` : ''})`);
  const readings = [];
  let response;
  for (const pass of steps) {
    response = await locateWhere({ systemOne, state: pass.state, questions: pass.questions, windows: pass.windows });
    readings.push(readAnswers(response.answers, pass));
  }
  const answers = mergeAnswers(readings);
  answers.where.text = lines[answers.where.line - 1]?.trim() ?? '';
  // A method too long for even MAX_PASSES was read in part. Say so, rather than let the answers read as if they were the whole of it.
  const to = steps.at(-1).covers.end_line;
  if (to < node.end_line) answers.read = { passes: steps.length, to_line: to, of_line: node.end_line };
  return { response, answers };
}

/** The events-log record of one questioned method. */
export const huntedEvent = ({ node, answers, response, huntId = null, root, github = null, revision, calleeIds, callerIds }) => ({
  type: 'hunted', at: new Date().toISOString(), id: findingId(node.id), hunt_id: huntId, root, github, revision, method: node.id, path: node.path, name: node.qualified_name, line: node.line, end_line: node.end_line,
  hash: node.hash, risk: node.metrics?.risk_score ?? null, model: response.model, ...answers, callees: calleeIds, callers: callerIds });

/**
 * Run one repository hunt: analyze the revision, read each changed candidate at most once,
 * append its model result, and continue through graph neighbors. `budget` limits successful
 * readings; failed readings are recorded and do not abort the walk unless two full batches fail.
 * Source is read from the requested revision, progress callbacks are called for every attempt,
 * and the hunt record is updated after each batch. Graph ids supplied by scan data or the model
 * are accepted only when they name a known, non-test node.
 */
const createWalk = (graph, candidates) => {
  const score = id => graph.nodes.get(id)?.metrics?.risk_score ?? 0;
  const visited = new Set(), stack = [], ranked = candidates.map(candidate => candidate.id);
  const enqueue = ids => {
    const valid = ids.filter(id => typeof id === 'string' && graph.nodes.has(id) && !visited.has(id) && !graph.nodes.get(id).test);
    stack.push(...valid.sort((a, b) => score(a) - score(b)));
  };
  const next = () => {
    while (stack.length) {
      const id = stack.pop();
      if (!visited.has(id)) return id;
    }
    while (ranked.length) {
      const id = ranked.shift();
      if (!visited.has(id) && graph.nodes.has(id)) return id;
    }
    return null;
  };
  return { visited, enqueue, next, remaining: () => ranked.filter(id => !visited.has(id)).length };
};

const createLineReader = (root, graph) => {
  const sources = new Map();
  return async node => {
    if (!sources.has(node.path)) {
      const file = graph.files.get(node.path)?.file;
      if (!file?.blob) throw new Error(`No source blob for ${node.id}`);
      sources.set(node.path, (await readBlob(root, file.blob)).split('\n'));
    }
    return sources.get(node.path);
  };
};

export async function scanRepository({ root, revision, out, analyzer, systemOne, label = root, github = null, paths = [], budget = Infinity, parallel = DEFAULT_PARALLEL, force = false,
  progress = () => {}, scanProgress = () => {}, log = () => {}, debug = () => {} }) {
  const store = openStore(out);
  const scan = await analyzeTree({ root, revision, out, analyzer, label, github, paths, progress: scanProgress, log, debug });
  const graph = buildGraph(scan.files);
  if (!scan.candidates.length) throw new Error('No methods to hunt in this repository');
  const hunted = force ? new Map() : await store.huntedIndex();
  const created = new Date().toISOString(), id = identity('hunt', revision, created);
  const dir = store.huntDir(id), huntPath = join(dir, 'hunt.json');
  const toRead = scan.candidates.filter(candidate => hunted.get(candidate.id) !== graph.nodes.get(candidate.id)?.hash).length;
  const total = Math.min(budget, toRead);
  const hunt = { id, status: 'running', target: label, github, root, revision, model: systemOne.id, paths, budget: Number.isFinite(budget) ? budget : null, parallel, force, scan_id: scan.id, out: dir, created_at: created,
    methods: scan.candidates.length, to_read: toRead, edges: graph.edgeCount(), calls: 0, skipped: 0, visited: [], failed: [], usage: { input_tokens: 0, output_tokens: 0 } };
  await writeJson(huntPath, hunt);

  const linesOf = createLineReader(root, graph), walk = createWalk(graph, scan.candidates);
  const byRisk = ids => [...ids].sort((a, b) => (graph.nodes.get(b)?.metrics?.risk_score ?? 0) - (graph.nodes.get(a)?.metrics?.risk_score ?? 0));
  const stepFor = async nodeId => {
    const node = graph.nodes.get(nodeId);
    const calleeIds = byRisk(graph.callees(nodeId)), callerIds = byRisk(graph.callers(nodeId));
    const callees = await Promise.all(calleeIds.map(async id => { const callee = graph.nodes.get(id); return { node: callee, lines: await linesOf(callee), calls: graph.callees(id) }; }));
    const callers = await Promise.all(callerIds.map(async id => { const caller = graph.nodes.get(id); return { node: caller, lines: await linesOf(caller), site: graph.site(id, nodeId), handover: graph.isDynamic(id, nodeId) }; }));
    const members = new Set([nodeId, ...calleeIds, ...callerIds, ...calleeIds.flatMap(id => graph.callees(id))]);
    const edges = [...members].flatMap(member => graph.callees(member).filter(target => members.has(target)).map(target => `${member.split('::').at(-1)} -> ${target.split('::').at(-1)}`));
    const file = graph.files.get(node.path).file;
    return { node, calleeIds, callerIds, steps: huntSteps({ node, lines: await linesOf(node), imports: file.imports, methods: file.methods, callees, callers, edges }) };
  };
  const ask = async nodeId => { const { node, calleeIds, callerIds, steps } = await stepFor(nodeId); const { response, answers } = await questionMethod({ systemOne, node, steps, lines: await linesOf(node), debug }); return { node, calleeIds, callerIds, response, answers }; };
  const record = async results => {
    for (const { node, calleeIds, callerIds, response, answers } of results) {
      hunt.calls++;
      hunt.usage.input_tokens += response.usage?.input_tokens ?? 0; hunt.usage.output_tokens += response.usage?.output_tokens ?? 0;
      const event = huntedEvent({ node, answers, response, huntId: id, root, github, revision, calleeIds, callerIds });
      await store.appendEvent(event); hunted.set(node.id, node.hash); hunt.visited.push({ ...event, status: 'hunted' });
      const follow = answers.follow?.method;
      walk.enqueue([...calleeIds, ...callerIds].filter(other => other !== follow));
      if (follow) walk.enqueue([follow]);
    }
  };
  let inARow = 0;
  try {
    while (hunt.calls < budget) {
      const batch = [];
      while (batch.length < Math.min(parallel, budget - hunt.calls)) {
        const nodeId = walk.next(); if (!nodeId) break;
        walk.visited.add(nodeId);
        const node = graph.nodes.get(nodeId);
        if (hunted.get(nodeId) === node.hash) { debug(`${nodeId}: unchanged since last hunt; skipping`); hunt.skipped++; hunt.visited.push({ method: nodeId, id: findingId(nodeId), path: node.path, name: node.qualified_name, line: node.line, status: 'unchanged' }); walk.enqueue([...graph.callees(nodeId), ...graph.callers(nodeId)]); }
        else batch.push(nodeId);
      }
      if (!batch.length) break;
      let done = 0;
      const settled = await Promise.all(batch.map(async nodeId => { try { const result = await ask(nodeId); progress(hunt.calls + ++done, total); return result; } catch (error) { progress(hunt.calls + ++done, total); const node = graph.nodes.get(nodeId); log(`${node.qualified_name} in ${node.path}: ${error.message}`); return { failed: { method: nodeId, id: findingId(nodeId), path: node.path, name: node.qualified_name, line: node.line, status: 'failed', error: error.message } }; } }));
      const results = settled.filter(result => !result.failed);
      for (const { failed } of settled.filter(result => result.failed)) { hunt.failed.push(failed); hunt.visited.push(failed); }
      inARow = results.length ? 0 : inARow + settled.length;
      if (inARow >= parallel * 2) throw new Error(`${inARow} methods in a row could not be read; last error: ${hunt.failed.at(-1)?.error ?? 'unknown'}`);
      await record(results); await writeJson(huntPath, hunt);
    }
    hunt.remaining = walk.remaining(); hunt.status = 'complete'; hunt.completed_at = new Date().toISOString(); await writeJson(huntPath, hunt); return hunt;
  } catch (error) { hunt.status = 'failed'; hunt.error = error.message; await writeJson(huntPath, hunt).catch(() => {}); throw error; }
}
