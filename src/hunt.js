/** `perch hunt`: walk the method graph from riskiest to least, asking a System One model about each method once. */
import { join } from 'node:path';
import { readBlob } from './git.js';
import { analyzeTree } from './scan.js';
import { buildGraph } from './graph.js';
import { huntStep, locateWhere, readAnswers } from './questions.js';
import { findingId, identity, openStore, writeJson } from './store.js';
export { findingId };

/** A scan reads every method it has not read before, or whose code changed since. `perch fix` works twenty issues by default. */
export const DEFAULT_FIX_BUDGET = 20, DEFAULT_PARALLEL = 8;

/** One System One pass over a method: the hunt's questions and the line they point at. */
export async function questionMethod({ systemOne, node, step, lines, debug = () => {} }) {
  debug(`asking ${systemOne.id} about ${node.qualified_name} in ${node.path}:${node.line} (${Object.keys(step.questions).length} questions${step.windows ? `, then a line in the chosen window` : ''})`);
  const response = await locateWhere({ systemOne, state: step.state, questions: step.questions, windows: step.windows });
  const answers = readAnswers(response.answers, step);
  answers.where.text = lines[answers.where.line - 1]?.trim() ?? '';
  return { response, answers };
}

/** The events-log record of one questioned method. */
export const huntedEvent = ({ node, answers, response, huntId = null, root, github = null, revision, calleeIds, callerIds }) => ({
  type: 'hunted', at: new Date().toISOString(), id: findingId(node.id), hunt_id: huntId, root, github, revision, method: node.id, path: node.path, name: node.qualified_name, line: node.line, end_line: node.end_line,
  hash: node.hash, risk: node.metrics?.risk_score ?? null, model: response.model, ...answers, callees: calleeIds, callers: callerIds });

/**
 * Analyze the selected repository revision, recording one model reading per method.
 * Unchanged methods are skipped, test methods are never queued, and `budget` bounds reads;
 * the hunt and its events are written to `out`, while model follow-ups are confined to graph nodes.
 */
function createHuntQueue(graph, ids, visited) {
  const pending = [], queued = new Set();
  const valid = id => typeof id === 'string' && graph.nodes.has(id) && !graph.nodes.get(id).test;
  const add = (idsToAdd, immediate = false) => {
    const candidates = [...new Set(idsToAdd.filter(id => valid(id) && !visited.has(id)))];
    if (immediate) {
      for (const id of candidates) { const index = pending.indexOf(id); if (index >= 0) pending.splice(index, 1); queued.delete(id); }
    }
    const fresh = candidates.filter(id => !queued.has(id));
    for (const id of fresh) queued.add(id);
    if (immediate) pending.unshift(...fresh);
    else {
      pending.push(...fresh);
      pending.sort((a, b) => (graph.nodes.get(b).metrics?.risk_score ?? 0) - (graph.nodes.get(a).metrics?.risk_score ?? 0));
    }
  };
  add(ids);
  return { add, next: () => { while (pending.length) { const id = pending.shift(); if (!visited.has(id)) return id; } return null; }, remaining: () => pending.filter(id => !visited.has(id)).length };
}

async function readMethodContext({ graph, root, nodeId, linesOf }) {
  const node = graph.nodes.get(nodeId);
  const rank = ids => [...ids].sort((a, b) => (graph.nodes.get(b).metrics?.risk_score ?? 0) - (graph.nodes.get(a).metrics?.risk_score ?? 0));
  const calleeIds = rank(graph.callees(nodeId)), callerIds = rank(graph.callers(nodeId));
  const callees = await Promise.all(calleeIds.map(async id => { const item = graph.nodes.get(id); return { node: item, lines: await linesOf(item), calls: graph.callees(id) }; }));
  const callers = await Promise.all(callerIds.map(async id => { const item = graph.nodes.get(id); return { node: item, lines: await linesOf(item), site: graph.site(id, nodeId), handover: graph.isDynamic(id, nodeId) }; }));
  const members = new Set([nodeId, ...calleeIds, ...callerIds, ...calleeIds.flatMap(id => graph.callees(id))]);
  const edges = [];
  for (const member of members) for (const target of graph.callees(member)) if (members.has(target)) edges.push(`${member.split('::').at(-1)} -> ${target.split('::').at(-1)}`);
  const file = graph.files.get(node.path).file;
  const step = huntStep({ node, lines: await linesOf(node), imports: file.imports, methods: file.methods, callees, callers, edges });
  return { node, calleeIds, callerIds, step };
}

export async function scanRepository({ root, revision, out, analyzer, systemOne, label = root, github = null, paths = [], budget = Infinity, parallel = DEFAULT_PARALLEL,
  force = false, progress = () => {}, scanProgress = () => {}, log = () => {}, debug = () => {} }) {
  const store = openStore(out);
  const scan = await analyzeTree({ root, revision, out, analyzer, label, github, paths, progress: scanProgress, log, debug });
  const graph = buildGraph(scan.files);
  if (!scan.candidates.length) throw new Error('No methods to hunt in this repository');
  const candidateIds = scan.candidates.map(candidate => candidate.id).filter(id => graph.nodes.has(id));
  const hunted = force ? new Map() : await store.huntedIndex();
  const created = new Date().toISOString(), id = identity('hunt', revision, created), dir = store.huntDir(id), huntPath = join(dir, 'hunt.json');
  const toRead = candidateIds.filter(id => hunted.get(id) !== graph.nodes.get(id).hash).length, total = Math.min(budget, toRead);
  const hunt = { id, status: 'running', target: label, github, root, revision, model: systemOne.id, paths, budget: Number.isFinite(budget) ? budget : null, parallel, force, scan_id: scan.id, out: dir, created_at: created,
    methods: candidateIds.length, to_read: toRead, edges: graph.edgeCount(), calls: 0, skipped: 0, visited: [], usage: { input_tokens: 0, output_tokens: 0 } };
  await writeJson(huntPath, hunt);
  const sources = new Map();
  const linesOf = async node => { if (!sources.has(node.path)) sources.set(node.path, (await readBlob(root, graph.files.get(node.path).file.blob)).split('\n')); return sources.get(node.path); };
  const visited = new Set(), queue = createHuntQueue(graph, candidateIds, visited);
  const ask = async nodeId => {
    const context = await readMethodContext({ graph, root, nodeId, linesOf });
    const { response, answers } = await questionMethod({ systemOne, node: context.node, step: context.step, lines: await linesOf(context.node), debug });
    return { ...context, response, answers };
  };
  const record = async results => { for (const { node, calleeIds, callerIds, response, answers } of results) {
    hunt.calls++;
    if (response.usage) { hunt.usage.input_tokens += response.usage.input_tokens ?? 0; hunt.usage.output_tokens += response.usage.output_tokens ?? 0; }
    const event = huntedEvent({ node, answers, response, huntId: id, root, github, revision, calleeIds, callerIds });
    await store.appendEvent(event); hunted.set(node.id, node.hash); hunt.visited.push({ ...event, status: 'hunted' });
    const follow = answers.follow?.method;
    queue.add([...calleeIds, ...callerIds].filter(other => other !== follow));
    if (typeof follow === 'string' && graph.nodes.has(follow) && !graph.nodes.get(follow).test) queue.add([follow], true);
  } };
  try {
    while (hunt.calls < budget) {
      const batch = [];
      while (batch.length < Math.min(parallel, budget - hunt.calls)) {
        const nodeId = queue.next(); if (!nodeId) break; visited.add(nodeId);
        const node = graph.nodes.get(nodeId);
        if (hunted.get(nodeId) === node.hash) { debug(`${nodeId}: unchanged since last hunt; skipping`); hunt.skipped++; hunt.visited.push({ method: nodeId, id: findingId(nodeId), path: node.path, name: node.qualified_name, line: node.line, status: 'unchanged' }); queue.add([...graph.callees(nodeId), ...graph.callers(nodeId)]); }
        else batch.push(nodeId);
      }
      if (!batch.length) break;
      let done = 0;
      await Promise.all(batch.map(async nodeId => { const result = await ask(nodeId); progress(hunt.calls + ++done, total); return result; })).then(record);
      await writeJson(huntPath, hunt);
    }
    hunt.remaining = queue.remaining(); hunt.status = 'complete'; hunt.completed_at = new Date().toISOString(); await writeJson(huntPath, hunt); return hunt;
  } catch (error) { hunt.status = 'failed'; hunt.error = error.message; await writeJson(huntPath, hunt).catch(() => {}); throw error; }
}
