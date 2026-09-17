/**
 * What perch knows about one method beyond its own source: where it sits, what it calls, what calls it, and the imports and
 * module scope around it. A question about a method that cannot see its callers is a question about a fragment.
 */
import { git } from './git.js';
import { analyzeTree } from './analyze.js';
import { buildGraph } from './graph.js';
import { FIX_LIMITS, FIX_NEIGHBOURS, FIX_STATE_BUDGET, methodStep, methodSteps } from './questions.js';

/**
 * The finding's method at `revision` (the checkout's HEAD by default) with the same neighborhood the scan showed: file lines, callees,
 * callers, imports, and the step built from them. `changed` says whether the method reads differently than when it was read.
 */
export async function methodContext({ finding, root, out, analyzer, revision = finding.revision, log = () => {} }) {
  const scan = await analyzeTree({ root, revision, out, analyzer, log });
  const graph = buildGraph(scan.files);
  const node = graph.nodes.get(finding.method);
  if (!node) throw new Error(`${finding.method} no longer exists at ${revision.slice(0, 12)}; scan again`);
  const sources = new Map();
  const linesOf = async member => { if (!sources.has(member.path)) sources.set(member.path, (await git(['show', `${revision}:${member.path}`], root)).split('\n')); return sources.get(member.path); };
  const callees = [], callers = [];
  const calleeIds = graph.callees(node.id), callerIds = graph.callers(node.id);
  for (const calleeId of calleeIds) { const callee = graph.nodes.get(calleeId); callees.push({ node: callee, lines: await linesOf(callee), calls: graph.callees(calleeId) }); }
  for (const callerId of callerIds) { const caller = graph.nodes.get(callerId); callers.push({ node: caller, lines: await linesOf(caller), site: graph.site(callerId, node.id), handover: graph.isDynamic(callerId, node.id) }); }
  const { imports, methods } = graph.files.get(node.path).file;
  const fileLines = await linesOf(node);
  const steps = methodSteps({ node, lines: fileLines, imports, methods, callees, callers });
  const step = steps[0];
  // What the rewriting model sees is not what System One sees: whole neighbors rather than excerpts, so it is not sent reading
  // files to find a contract perch already has. The scan's own state stays as it was, or a rescan would not compare like for like.
  const context = methodStep({ node, lines: fileLines, imports, methods, callees, callers, budget: FIX_STATE_BUDGET, limits: FIX_LIMITS, maxCallees: FIX_NEIGHBOURS, maxCallers: FIX_NEIGHBOURS }).state;
  const method = fileLines.slice(node.line - 1, node.end_line).join('\n');
  return { scan, graph, node, fileLines, method, callees, callers, calleeIds, callerIds, imports, methods, step, steps, context, changed: Boolean(finding.hash) && node.hash !== finding.hash };
}

/**
 * Findings whose method still exists at HEAD, and the rest. A changed method is re-questioned when its turn comes; one that is gone
 * (removed, renamed, or moved to another file) has nothing left to fix under that name.
 */
export function splitStale(findings, scan) {
  const live = new Set((scan.files ?? []).flatMap(file => file.methods.map(method => method.id)));
  const current = [], stale = [];
  // A finding with no method is not about one: a broken rule can be about a whole file, and a file is not a method that vanished.
  for (const finding of findings) (!finding.method || live.has(finding.method) ? current : stale).push(finding);
  return { current, stale };
}
