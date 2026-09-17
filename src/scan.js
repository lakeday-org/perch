/**
 * `perch scan`: walk the method graph from riskiest to least, asking a System One model about each method once.
 *
 * Everything perch asks is asked here. The questions it ships with and the rules you write are one set, so a rule about a method
 * rides in that method's own request and costs nothing extra to ask. A rule about a file or a test is not about a method at all,
 * and gets its own request after the walk.
 */
import { join } from 'node:path';
import { listTree, readBlob } from './git.js';
import { analyzeTree } from './analyze.js';
import { buildGraph } from './graph.js';
import { askKey, CORRECTNESS, floorFor, questionSet, questionsFor, SEARCHES } from './ask.js';
import { issuesOf, label as kindLabel, methodSteps, locateWhere, readAnswers } from './questions.js';
import { asRules, askUnits, readRules, RULES_FILE, rulesForMethod, searchUnits, selectUnits, UNIT_PARALLEL } from './units.js';
import { findingId, identity, openStore, writeJson } from './store.js';
export { findingId };

/** Methods in flight at once. Each request carries a whole neighborhood and thirty questions, so this is where the size is. */
export const DEFAULT_PARALLEL = 8;

/**
 * What one method's readings say together. The first pass carries the neighborhood and answers for the method as a whole, so its
 * judgement of shape, documentation and callers stands. A later pass sees only its own slice, so it can only add: the worst defect
 * found anywhere is the method's defect, and a vulnerability is the likeliest reading of it from any pass.
 *
 * Which answers a slice may add is read from the questions rather than listed here. A slice can honestly turn up a defect or a
 * vulnerability, so those grow, and so does anything they are gated on. Whether the comment is wrong, or the method too big, is
 * about the method entire, and belongs to the pass that saw its whole neighborhood.
 */
export function mergeAnswers(readings, questions = questionSet().filter(question => question.each === 'method')) {
  const merged = { ...readings[0] };
  const gates = new Set(questions.filter(question => CORRECTNESS.has(question.issue?.type)).map(question => question.when).filter(Boolean));
  const grows = questions.filter(question => question.type === 'noul' && (CORRECTNESS.has(question.issue?.type) || gates.has(question.name)));
  for (const later of readings.slice(1)) {
    if (later.has_bug > merged.has_bug) Object.assign(merged, { has_bug: later.has_bug, where: later.where, kind: later.kind, severity: later.severity });
    for (const question of grows) merged[question.name] = Math.max(merged[question.name] ?? 0, later[question.name] ?? 0);
  }
  if (readings.length > 1) merged.passes = readings.length;
  return merged;
}

/** One System One reading of a method, in as many passes as its length takes, and the line they point at. */
export async function questionMethod({ systemOne, node, step, steps = [step], lines, rules = [], debug = () => {} }) {
  debug(`asking ${systemOne.id} about ${node.qualified_name} in ${node.path}:${node.line} (${Object.keys(steps[0].questions).length} questions${steps.length > 1 ? ` over ${steps.length} passes` : ''}${steps[0].windows ? `, then a line in the chosen window` : ''})`);
  const readings = [];
  let response;
  for (const pass of steps) {
    response = await locateWhere({ systemOne, state: pass.state, questions: pass.questions, windows: pass.windows });
    readings.push(readAnswers(response.answers, pass));
  }
  const answers = mergeAnswers(readings, [...questionSet().filter(question => question.each === 'method' && !question.kind), ...rules]);
  answers.where.text = lines[answers.where.line - 1]?.trim() ?? '';
  // A method too long for even MAX_PASSES was read in part. Say so, rather than let the answers read as if they were the whole of it.
  const to = steps.at(-1).covers.end_line;
  if (to < node.end_line) answers.read = { passes: steps.length, to_line: to, of_line: node.end_line };
  return { response, answers };
}

/** Whether a label on an issue is one this question raises, so a run can say how often each of its own questions fired. */
const labelsRaisedBy = (question, label) => {
  const wanted = question.issue?.label ?? 'self';
  if (wanted === 'self') return kindLabel(question.name) === label;
  const named = questionSet().find(other => other.name === wanted && other.type === 'choice');
  if (!named) return kindLabel(wanted) === label;
  return Object.keys(named.options).some(option => kindLabel(option) === label && option !== question.issue.except);
};

/**
 * The answers are spread flat onto the row, so every question's name is a column of its own and a question added later widens
 * the record rather than nesting under it. `key` is what the next run compares against to decide it already has this answer.
 */
export const readEvent = ({ node, answers, response, key, runId = null, root, github = null, revision, calleeIds, callerIds }) => ({
  type: 'read', at: new Date().toISOString(), id: findingId(node.id), run_id: runId, root, github, revision, method: node.id, path: node.path, name: node.qualified_name, line: node.line, end_line: node.end_line,
  hash: node.hash, key, risk: node.metrics?.risk_score ?? null, model: response.model, ...answers, callees: calleeIds, callers: callerIds });

/**
 * The order methods are read in: riskiest neighbor first off the stack, then the next riskiest method overall. An id from the
 * scan or from the model is taken only when it names a node the graph actually has, is not a test, and is in scope. A neighbor
 * outside scope is in view as context for the method that names it, and is not itself read: what a run covers is what it covers.
 */
const createWalk = (graph, candidates, inScope = () => true) => {
  const score = id => graph.nodes.get(id)?.metrics?.risk_score ?? 0;
  const visited = new Set(), stack = [], ranked = candidates.map(candidate => candidate.id);
  const enqueue = ids => {
    const valid = ids.filter(id => typeof id === 'string' && graph.nodes.has(id) && !visited.has(id)
      && !graph.nodes.get(id).test && inScope(graph.nodes.get(id).path));
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

/**
 * One scan over a repository: analyze the revision, read every method in scope, and walk on through its neighbors, asking the
 * questions perch ships with and the rules you wrote in the same request. A reading that fails is recorded against its method and
 * the walk carries on, unless two full batches fail in a row. The record is written after every batch.
 *
 * What a run covers is `paths`, which is a directory you named or what a branch changed. There is no cap on how many methods it
 * reads: a number that stops partway through leaves a report that looks complete and is not.
 */
export async function scanRepository({ root, revision, out, analyzer, systemOne, label = root, github = null, paths = [], parallel = DEFAULT_PARALLEL,
  unitParallel = UNIT_PARALLEL, min = 0.5, filters = [], onFile = () => {}, progress = () => {}, unitProgress = () => {}, searchProgress = () => {}, scanProgress = () => {}, log = () => {}, debug = () => {} }) {
  const store = openStore(out);
  // The whole tree is parsed however narrow the run is. Parsing is free next to a request, and a method's callers matter whether
  // or not they are in the diff: a graph cut down to what a branch touched cannot say who calls into it.
  const scan = await analyzeTree({ root, revision, out, analyzer, label, github, progress: scanProgress, log, debug });
  const graph = buildGraph(scan.files);
  if (!scan.candidates.length) throw new Error('No methods to read in this repository');
  const rules = asRules(await readRules(root, revision));
  // --since and --paths say what this run reads, not what perch knows. A method outside is neither read nor reported here, and
  // what the last run said about it is carried onto the file at the end rather than dropped.
  const inScope = path => !paths.length || paths.some(item => path === item || path.startsWith(item.replace(/\/$/, '') + '/'));
  const candidates = scan.candidates.filter(candidate => graph.nodes.has(candidate.id) && inScope(graph.nodes.get(candidate.id).path));
  if (!candidates.length) throw new Error('Nothing in scope to read');
  const candidateIds = candidates.map(candidate => candidate.id);
  const created = new Date().toISOString(), id = identity('scan', revision, created);
  const dir = store.runDir(id), runPath = join(dir, 'run.json');
  const total = candidateIds.length;
  const run = { id, status: 'running', target: label, github, root, revision, model: systemOne.id, paths, parallel, scan_id: scan.id, out: dir, created_at: created,
    methods: total, to_read: total, rules: rules.length, filters, edges: graph.edgeCount(), calls: 0, carried: 0, skipped: 0, checked: 0, visited: [], broken: [], failed: [], usage: { input_tokens: 0, output_tokens: 0 } };
  await writeJson(runPath, run);

  // A file is reported the moment every method in it has been accounted for, rather than the run being held back to the end. A
  // method that could not be read counts: a file must not wait forever on one that will never arrive.
  // What the last run said, to carry forward anything it already answered. This is not a log: a row only survives when the state
  // that produced it would be sent again word for word, so the file still describes this commit and nothing older.
  const { dismissals, latest, checks } = await store.indexes();
  const earlier = latest;
  const inFile = new Map();
  for (const candidate of candidates) {
    const path = graph.nodes.get(candidate.id).path;
    inFile.set(path, [...(inFile.get(path) ?? []), candidate.id]);
  }
  // A closure covers named kinds rather than the method, so a method you set aside for one thing still reports another. Read
  // here as well as in the report, because a finding you had already looked at used to stay out of the list and fail the run
  // anyway, which is the worst of both.
  const setAside = (id, kind) => (dismissals.get(id)?.kinds ?? new Set()).has(kind);
  const done = new Map();
  const finish = (path, event) => {
    done.set(path, [...(done.get(path) ?? []), event].filter(Boolean));
    if ((done.get(path).length + (missing.get(path) ?? 0)) < inFile.get(path).length) return;
    // What you have closed is decided here too, so a file reads the same as it streams past and in the list afterwards.
    onFile(path, done.get(path).map(finding => {
      const held = dismissals.get(finding.id);
      return held?.kinds.size ? { ...finding, closed: { kinds: [...held.kinds], at: held.at, reason: held.reason } } : finding;
    }));
  };
  const missing = new Map();

  const linesOf = createLineReader(root, graph), walk = createWalk(graph, candidates, inScope);
  const byRisk = ids => [...ids].sort((a, b) => (graph.nodes.get(b)?.metrics?.risk_score ?? 0) - (graph.nodes.get(a)?.metrics?.risk_score ?? 0));
  const stepFor = async nodeId => {
    const node = graph.nodes.get(nodeId);
    const calleeIds = byRisk(graph.callees(nodeId)), callerIds = byRisk(graph.callers(nodeId));
    const callees = await Promise.all(calleeIds.map(async id => { const callee = graph.nodes.get(id); return { node: callee, lines: await linesOf(callee), calls: graph.callees(id) }; }));
    const callers = await Promise.all(callerIds.map(async id => { const caller = graph.nodes.get(id); return { node: caller, lines: await linesOf(caller), site: graph.site(id, nodeId), handover: graph.isDynamic(id, nodeId) }; }));
    const members = new Set([nodeId, ...calleeIds, ...callerIds, ...calleeIds.flatMap(id => graph.callees(id))]);
    const edges = [...members].flatMap(member => graph.callees(member).filter(target => members.has(target)).map(target => `${member.split('::').at(-1)} -> ${target.split('::').at(-1)}`));
    const file = graph.files.get(node.path).file;
    // Your rules about this method are asked in its request, beside perch's own. A method covered by five rules costs one reading,
    // not six.
    // A filter narrows what is asked, not just what is printed. Asking thirty questions about a method to print two is paying
    // for twenty-eight answers nobody reads, and a method no kept question covers is not read at all.
    const asked = questionsFor([...questionSet().filter(question => question.each === 'method' && !question.kind), ...rulesForMethod(rules, node)], filters, kindLabel);
    const own = asked.filter(question => question.kind);
    if (!asked.length) return { node, calleeIds, callerIds, rules: own, skip: true };
    const steps = methodSteps({ node, lines: await linesOf(node), imports: file.imports, methods: file.methods, callees, callers, edges, asked });
    return { node, calleeIds, callerIds, rules: own, steps, key: askKey(steps, asked) };
  };
  const ask = async nodeId => {
    const { node, calleeIds, callerIds, rules: own, steps, key, skip } = await stepFor(nodeId);
    if (skip) return { node, calleeIds, callerIds, rules: own, skipped: true };
    // The same state and the same questions have an answer already. Asking again would spend a request to be told what is on
    // disk, and would move the percentages on an issue nobody has touched, which is worse: a row you looked at yesterday should
    // read the same today unless the code did something.
    const before = earlier.get(node.id);
    if (before?.key === key) { debug(`${node.qualified_name} in ${node.path} is unchanged since it was read`); return { node, calleeIds, callerIds, rules: own, carried: before }; }
    const { response, answers } = await questionMethod({ systemOne, node, steps, lines: await linesOf(node), rules: own, debug });
    return { node, calleeIds, callerIds, rules: own, response, answers, key };
  };
  /** Every reading this run made. The file is written whole at the end, so what this run did not cover is carried onto it. */
  const read = [], broken = [];
  const record = async results => {
    for (const { node, calleeIds, callerIds, rules: own, response, answers, key, carried, skipped } of results) {
      // A filter narrows which questions are asked, not which code the run is about, so what it did not ask about is what the
      // last run said rather than nothing at all. Rewriting the file whole with only the answers this run happened to want threw
      // away every other answer on the same method.
      const before = filters.length ? earlier.get(node.id) : null;
      if (skipped) { run.skipped++; if (before) read.push(before); continue; }
      if (carried) run.carried++; else run.calls++;
      run.usage.input_tokens += response?.usage?.input_tokens ?? 0; run.usage.output_tokens += response?.usage?.output_tokens ?? 0;
      const fresh = carried ?? readEvent({ node, answers, response, key, runId: id, root, github, revision, calleeIds, callerIds });
      const event = before ? { ...before, ...fresh } : fresh;
      read.push(event); run.visited.push({ ...event, status: carried ? 'carried' : 'read' });
      finish(node.path, event);
      // A rule asked of this method answered under its own name, and a rule is broken when the answer is no. The answer is
      // already in the reading, so nothing more is written down: a second row for it would list the same problem twice. The run
      // keeps its own tally, which is what the exit code and the summary read.
      for (const rule of own) {
        const failed = 1 - (event[rule.name] ?? 1);
        if (failed > floorFor(rule, min) && !setAside(findingId(node.id), rule.name)) run.broken.push({ rule: rule.name, path: node.path, name: node.qualified_name, line: node.line, broken: failed, said: rule.text });
      }
      const follow = event.follow?.method;
      walk.enqueue([...calleeIds, ...callerIds].filter(other => other !== follow));
      if (follow) walk.enqueue([follow]);
      // The rest of this file goes on top of all of it. A run over a repository is read file by file, which means finishing the
      // one in hand before opening another; the model's suggestion still decides which file that is once this one is done.
      walk.enqueue(inFile.get(node.path) ?? []);
    }
  };

  let inARow = 0;
  try {
    // Said once before anything is asked. A counter that only moves when an answer arrives shows the phase before it, frozen,
    // for as long as the first request takes, which on a service that is retrying is a long time and reads as a hang.
    progress(0, total);
    for (;;) {
      const batch = [];
      while (batch.length < parallel) {
        const nodeId = walk.next(); if (!nodeId) break;
        walk.visited.add(nodeId);
        batch.push(nodeId);
      }
      if (!batch.length) break;
      let done = 0;
      const settled = await Promise.all(batch.map(async nodeId => { try { const result = await ask(nodeId); progress(run.calls + ++done, total); return result; } catch (error) { progress(run.calls + ++done, total); const node = graph.nodes.get(nodeId); log(`${node.qualified_name} in ${node.path}: ${error.message}`); return { failed: { method: nodeId, id: findingId(nodeId), path: node.path, name: node.qualified_name, line: node.line, status: 'failed', error: error.message } }; } }));
      const results = settled.filter(result => !result.failed);
      for (const { failed } of settled.filter(result => result.failed)) {
        run.failed.push(failed); run.visited.push(failed);
        missing.set(failed.path, (missing.get(failed.path) ?? 0) + 1);
        finish(failed.path, null);
      }
      inARow = results.length ? 0 : inARow + settled.length;
      if (inARow >= parallel * 2) throw new Error(`${inARow} methods in a row could not be read; last error: ${run.failed.at(-1)?.error ?? 'unknown'}`);
      await record(results); await writeJson(runPath, run);
    }

    // What is left is every rule that is not about a method, and every claim about the codebase rather than about one file. The
    // source they are asked about comes from the revision, not from disk, so a finding is still about a commit.
    const files = new Map();
    for (const file of scan.files) files.set(file.path, (await linesOf({ id: file.path, path: file.path })).join('\n'));
    const tree = await listTree(root, revision);
    for (const item of tree) if (item.type === 'blob' && !files.has(item.path)) files.set(item.path, await readBlob(root, item.sha).catch(() => ''));
    const over = { scan, graph, files, tree, revision, systemOne, inScope, min, debug, earlier: checks };
    const kept = new Set(questionsFor(rules, filters, kindLabel).map(rule => rule.name));
    const asking = rules.filter(rule => kept.has(rule.name));
    const units = await askUnits({ ...over, rules: asking.filter(rule => !SEARCHES(rule.kind) && rule.each !== 'method'), parallel: unitParallel, progress: unitProgress });
    const searches = await searchUnits({ ...over, rules: asking.filter(rule => SEARCHES(rule.kind)), parallel: unitParallel, progress: searchProgress });
    run.carried += units.carried + searches.carried;
    // What each rule actually covered. A selector that matches nothing is a rule that never fires and never says so, which is
    // the one kind of broken rule you cannot see by reading the report: it looks exactly like a rule nothing violates.
    // A rule about a file or a test has no reading to sit inside, so it is a check of its own. Every one is written down, passed
    // or broken, since a pass is what lets the next run skip asking it; only the broken ones are anything to report.
    broken.push(...units.results, ...searches.results);
    run.broken.push(...[...units.results, ...searches.results]
      .filter(result => result.broken > floorFor(rules.find(rule => rule.name === result.rule), min) && !setAside(result.id, result.rule)));
    // Every question the run asked, yours and perch's alike. A question perch ships can cover nothing and raise nothing for the
    // same reasons one you wrote can, and a report of a run that names only half of what it asked is half a report.
    const raised = new Map();
    for (const event of read) for (const issue of issuesOf(event, min)) raised.set(issue.label, (raised.get(issue.label) ?? 0) + 1);
    run.coverage = [
      ...questionSet().filter(question => question.each === 'method' && !question.kind).map(question => ({
        name: question.name, from: 'builtin', where: question.where, units: read.length,
        broken: question.issue ? [...raised].filter(([label]) => labelsRaisedBy(question, label)).reduce((total, [, count]) => total + count, 0) : null,
      })),
      ...rules.map(rule => ({
        name: rule.name,
        from: RULES_FILE,
        where: rule.where,
        units: rule.each === 'method' && !SEARCHES(rule.kind)
          ? candidates.filter(candidate => rulesForMethod([rule], graph.nodes.get(candidate.id)).length).length
          : selectUnits(rule, { scan, graph, files, tree, inScope }).length,
        broken: run.broken.filter(finding => finding.rule === rule.name).length,
      })),
    ];
    run.checked = run.calls * questionSet().filter(question => question.each === 'method').length + units.asked + searches.asked;

    // What this run did not cover. --paths and --since say which code a run is about, and --filter says which questions it asks;
    // neither says the rest of the repository stopped existing. Writing the file with only what this run touched threw away
    // every reading outside it, so `perch scan --paths one/file.js` left a store that knew about one file.
    const walked = new Set(read.map(event => event.method));
    const elsewhere = [...earlier.values()].filter(event => !walked.has(event.method) && graph.nodes.has(event.method));
    // Rule checks are carried the same way, and only while the rule that produced one is still that rule. A rule reworded,
    // reshaped or deleted since leaves a check describing a question that no longer exists, and a rule asked of every method now
    // would keep answering as the search it was.
    const said = new Set(broken.map(check => check.id));
    const byName = new Map(rules.map(rule => [rule.name, rule]));
    const unasked = [...checks.values()].filter(check => !said.has(check.id) && byName.get(check.rule)?.hash === check.rule_hash);
    await store.recordScan([...read, ...elsewhere, ...broken, ...unasked]);
    run.remaining = walk.remaining(); run.status = 'complete'; run.completed_at = new Date().toISOString(); await writeJson(runPath, run); return run;
  } catch (error) { run.status = 'failed'; run.error = error.message; await writeJson(runPath, run).catch(() => {}); throw error; }
}
