/**
 * What perch knows about one method beyond its own source: what it calls and what calls it, with the source of each. A question
 * about a method that cannot see its callers is a question about a fragment.
 */
import { git } from './git.js';
import { analyzeTree } from './analyze.js';
import { buildGraph } from './graph.js';

/**
 * A method's neighbours as every request about it shows them: its callees and callers, riskiest first, each with its file's
 * lines, and the calls drawn between them as [from, to] pairs of method ids. A scan and a check both ask over this, so the
 * same method is the same state in both and an answer one of them paid for is the other's too.
 *
 * An edge starts at the method or one of its neighbours, whose source a request can show, and ends at one of them or at
 * something a callee calls. One starting anywhere else is about code no request holds.
 */
export async function methodNeighbours(graph, nodeId, linesOf) {
  const risk = id => graph.nodes.get(id)?.metrics?.risk_score ?? 0;
  const byRisk = ids => [...ids].sort((a, b) => risk(b) - risk(a));
  const calleeIds = byRisk(graph.callees(nodeId)), callerIds = byRisk(graph.callers(nodeId));
  const callees = await Promise.all(calleeIds.map(async id => { const callee = graph.nodes.get(id); return { node: callee, lines: await linesOf(callee) }; }));
  const callers = await Promise.all(callerIds.map(async id => { const caller = graph.nodes.get(id); return { node: caller, lines: await linesOf(caller), site: graph.site(id, nodeId), handover: graph.isDynamic(id, nodeId) }; }));
  const shown = [...new Set([nodeId, ...calleeIds, ...callerIds])];
  const members = new Set([...shown, ...calleeIds.flatMap(id => graph.callees(id))]);
  const edges = shown.flatMap(from => graph.callees(from).filter(to => members.has(to)).map(to => [from, to]));
  return { calleeIds, callerIds, callees, callers, edges };
}

/**
 * The finding's method at `revision`, the checkout's HEAD by default, with the neighborhood the scan read it in: what it calls
 * and what calls it. Every neighbor's source comes with it, since a question about a method that cannot see its callers is a
 * question about a fragment.
 */
export async function methodContext({ finding, root, out, analyzer, revision = finding.revision, log = () => {} }) {
  const scan = await analyzeTree({ root, revision, out, analyzer, log });
  const graph = buildGraph(scan.files);
  const node = graph.nodes.get(finding.method);
  if (!node) throw new Error(`${finding.method} no longer exists at ${revision.slice(0, 12)}; scan again`);
  const sources = new Map();
  const linesOf = member => { if (!sources.has(member.path)) sources.set(member.path, git(['show', `${revision}:${member.path}`], root).then(text => text.split('\n'))); return sources.get(member.path); };
  const { callees, callers, edges } = await methodNeighbours(graph, node.id, linesOf);
  return { node, callees, callers, edges };
}

/**
 * Findings whose method still exists at HEAD, and the rest. A changed method is re-questioned when its turn comes; one that is gone
 * (removed, renamed, or moved to another file) has nothing left to fix under that name. A rule's answer about a method is stale
 * once the method's hash moves, since it is about text that is not there any more.
 */
export function splitStale(findings, scan) {
  const live = new Map((scan.files ?? []).flatMap(file => file.methods.map(method => [method.id, method.hash])));
  const current = [], stale = [];
  // A finding with no method is not about one: a broken rule can be about a whole file, and a file is not a method that vanished.
  const stands = finding => !finding.method || (live.has(finding.method) && (!finding.rule || live.get(finding.method) === finding.hash));
  for (const finding of findings) (stands(finding) ? current : stale).push(finding);
  return { current, stale };
}
