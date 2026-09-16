/** `perch hunt`: walk the method graph from riskiest to least, asking a System One model about each method once. */
import { join } from 'node:path';
import { readBlob } from './git.js';
import { runScan } from './scan.js';
import { buildGraph } from './graph.js';
import { huntStep, readAnswers } from './questions.js';
import { identity, openStore, writeJson } from './store.js';

export const DEFAULT_BUDGET = 20, DEFAULT_PARALLEL = 8;
/** A short stable handle for a method's finding, the same across hunts. */
export const findingId = method => identity('finding', method).slice(0, 8);

export async function runHunt({ root, revision, out, analyzer, systemOne, label = root, github = null, paths = [], budget = DEFAULT_BUDGET, parallel = DEFAULT_PARALLEL, force = false,
  progress = () => {}, scanProgress = () => {}, log = () => {}, debug = () => {} }) {
  const store = openStore(out);
  const scan = await runScan({ root, revision, out, analyzer, label, github, paths, progress: scanProgress, log, debug });
  const graph = buildGraph(scan.files);
  if (!scan.candidates.length) throw new Error('No methods to hunt in this repository');
  const hunted = force ? new Map() : await store.huntedIndex();
  const created = new Date().toISOString();
  const id = identity('hunt', revision, created);
  const dir = store.huntDir(id), huntPath = join(dir, 'hunt.json');
  const hunt = { id, status: 'running', target: label, github, root, revision, model: systemOne.id, paths, budget, parallel, force, scan_id: scan.id, out: dir, created_at: created,
    methods: scan.candidates.length, edges: graph.edgeCount(), calls: 0, skipped: 0, visited: [], usage: { input_tokens: 0, output_tokens: 0 } };
  await writeJson(huntPath, hunt);

  const sources = new Map();
  const linesOf = async node => {
    if (!sources.has(node.path)) sources.set(node.path, (await readBlob(root, graph.files.get(node.path).file.blob)).split('\n'));
    return sources.get(node.path);
  };
  const score = nodeId => graph.nodes.get(nodeId).metrics?.risk_score ?? 0;
  const byRisk = ids => [...ids].sort((a, b) => score(b) - score(a));
  const visited = new Set();
  const ranked = scan.candidates.map(candidate => candidate.id);
  const stack = [];
  /** Riskiest unvisited neighbor first; the stack pops from the end. */
  const push = ids => stack.push(...ids.filter(nodeId => !visited.has(nodeId) && !graph.nodes.get(nodeId).test).sort((a, b) => score(a) - score(b)));
  const next = () => {
    while (stack.length) { const nodeId = stack.pop(); if (!visited.has(nodeId)) return nodeId; }
    while (ranked.length) { const nodeId = ranked.shift(); if (!visited.has(nodeId)) return nodeId; }
    return null;
  };

  /** Everything the model is shown about one method: its file's imports, callees with their own callees, callers with their call sites, and the edges among them. */
  const stepFor = async nodeId => {
    const node = graph.nodes.get(nodeId);
    const calleeIds = byRisk(graph.callees(nodeId)), callerIds = byRisk(graph.callers(nodeId));
    const callees = [], callers = [];
    for (const calleeId of calleeIds) { const callee = graph.nodes.get(calleeId); callees.push({ node: callee, lines: await linesOf(callee), calls: graph.callees(calleeId) }); }
    for (const callerId of callerIds) { const caller = graph.nodes.get(callerId); callers.push({ node: caller, lines: await linesOf(caller), site: graph.site(callerId, nodeId) }); }
    const members = new Set([nodeId, ...calleeIds, ...callerIds, ...calleeIds.flatMap(calleeId => graph.callees(calleeId))]);
    const edges = [];
    for (const member of members) for (const target of graph.callees(member)) if (members.has(target)) edges.push(`${member.split('::').at(-1)} -> ${target.split('::').at(-1)}`);
    return { node, calleeIds, callerIds, step: huntStep({ node, lines: await linesOf(node), imports: graph.files.get(node.path).file.imports, callees, callers, edges }) };
  };

  const ask = async nodeId => {
    const { node, calleeIds, callerIds, step } = await stepFor(nodeId);
    debug(`asking ${systemOne.id} about ${node.qualified_name} in ${node.path}:${node.line} (${Object.keys(step.questions).length} questions)`);
    const response = await systemOne.ask(step.state, step.questions);
    const answers = readAnswers(response.answers, step);
    answers.where.text = (await linesOf(node))[answers.where.line - 1]?.trim() ?? '';
    return { node, calleeIds, callerIds, response, answers };
  };

  try {
    while (hunt.calls < budget) {
      const batch = [];
      while (batch.length < Math.min(parallel, budget - hunt.calls)) {
        const nodeId = next();
        if (!nodeId) break;
        visited.add(nodeId);
        const node = graph.nodes.get(nodeId);
        if (hunted.get(nodeId) === node.hash) {
          debug(`${nodeId}: unchanged since last hunt; skipping`);
          hunt.skipped++;
          hunt.visited.push({ method: nodeId, id: findingId(nodeId), path: node.path, name: node.qualified_name, line: node.line, status: 'unchanged' });
          push([...graph.callees(nodeId), ...graph.callers(nodeId)]);
          continue;
        }
        batch.push(nodeId);
      }
      if (!batch.length) break;
      let done = 0;
      const results = await Promise.all(batch.map(async nodeId => { const result = await ask(nodeId); progress(hunt.calls + ++done, budget); return result; }));
      for (const { node, calleeIds, callerIds, response, answers } of results) {
        hunt.calls++;
        if (response.usage) { hunt.usage.input_tokens += response.usage.input_tokens ?? 0; hunt.usage.output_tokens += response.usage.output_tokens ?? 0; }
        const event = { type: 'hunted', at: new Date().toISOString(), id: findingId(node.id), hunt_id: id, root, github, revision, method: node.id, path: node.path, name: node.qualified_name, line: node.line, end_line: node.end_line,
          hash: node.hash, risk: node.metrics?.risk_score ?? null, model: response.model, ...answers, callees: calleeIds, callers: callerIds };
        await store.appendEvent(event);
        hunted.set(node.id, node.hash);
        hunt.visited.push({ ...event, status: 'hunted' });
        push([...calleeIds, ...callerIds].filter(other => other !== answers.follow.method));
        if (answers.follow.method) push([answers.follow.method]);
      }
      await writeJson(huntPath, hunt);
    }
    hunt.remaining = ranked.filter(nodeId => !visited.has(nodeId)).length;
    hunt.status = 'complete';
    hunt.completed_at = new Date().toISOString();
    await writeJson(huntPath, hunt);
    return hunt;
  } catch (error) {
    hunt.status = 'failed';
    hunt.error = error.message;
    await writeJson(huntPath, hunt).catch(() => {});
    throw error;
  }
}
