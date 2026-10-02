/**
 * `perch scan`: walk the method graph from riskiest to least, asking a System One model about each method once.
 *
 * Everything perch asks is asked here. The questions it ships with and the rules you write are one set, so a rule about a method
 * rides in that method's own request and costs nothing extra to ask. A rule about a file or a test is not about a method at all,
 * and gets its own request after the walk.
 */
import { listTree, readBlob } from './git.js';
import { analyzeTree } from './analyze.js';
import { AuthenticationError } from './systemone.js';
import { createFileSelector } from './exclusions.js';
import { buildGraph } from './graph.js';
import { methodNeighbours } from './context.js';
import { appliesToLanguage, CORRECTNESS, floorFor, DEFAULT_TYPES, questionSet, questionsFor, SEARCHES } from './ask.js';
import { issuesOf, label as kindLabel, methodSteps, readAnswers } from './questions.js';
import { asRules, askUnits, matches, readIgnored, readRules, readScanTypes, RULES_FILE, rulesForMethod, searchUnits, selectUnits, UNIT_PARALLEL, unitHash } from './units.js';
import { findingId, identity, openStore } from './store.js';
import { TOKEN_LIMITS, IncompleteCheckError, withTokenRetries } from './tokens.js';
export { findingId };

/**
 * Methods in flight at once. Each request carries a whole neighborhood and the applicable question pack. The service takes 600
 * requests a minute for an organization and retries a busy provider itself, so eight left most of that unused.
 */
export const DEFAULT_PARALLEL = 32;

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
  // Only a question some pass was asked has anything to grow. A filtered run asks a few of them, and the rest came out of here
  // answered 0, which then overwrote what the last run had said about them.
  const grows = questions.filter(question => question.type === 'noul' && (CORRECTNESS.has(question.issue?.type) || gates.has(question.name))
    && readings.some(reading => reading[question.name] !== undefined));
  for (const later of readings.slice(1)) {
    if (later.has_bug > merged.has_bug) Object.assign(merged, { has_bug: later.has_bug, kind: later.kind, severity: later.severity });
    for (const question of grows) merged[question.name] = Math.max(merged[question.name] ?? 0, later[question.name] ?? 0);
  }
  if (readings.length > 1) merged.passes = readings.length;
  return merged;
}

/** One System One reading of a method, in as many passes as its length takes. */
export async function questionMethod({ systemOne, node, step, steps = [step], rules = [], debug = () => {}, prepare }) {
  return withTokenRetries(async budget => {
    if (budget < (systemOne.limits?.state ?? TOKEN_LIMITS.state) && !prepare) throw new IncompleteCheckError('source cannot be rebuilt for a smaller token budget');
    const active = steps?.[0] && budget === (systemOne.limits?.state ?? TOKEN_LIMITS.state) ? steps : prepare ? prepare(budget) : steps;
    debug(`asking ${systemOne.id} about ${node.qualified_name} in ${node.path}:${node.line} (${Object.keys(active[0].questions).length} questions${active.length > 1 ? ` over ${active.length} passes` : ''})`);
    const readings = [];
    let response;
    for (const pass of active) {
      response = await systemOne.ask(pass.state, pass.questions);
      readings.push(readAnswers(response.answers, pass));
    }
    const answers = mergeAnswers(readings, [...questionSet().filter(question => question.each === 'method' && !question.kind), ...rules]);
    // A partial source reading must remain visible instead of looking like a complete method check.
    const to = active.at(-1).covers.end_line;
    if (to < node.end_line) answers.read = { passes: active.length, to_line: to, of_line: node.end_line };
    return { response, answers };
  }, systemOne.limits?.state);
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
 * the record rather than nesting under it.
 */
export const readEvent = ({ node, answers, response, runId = null, root, github = null, revision, calleeIds, callerIds }) => ({
  type: 'read', at: new Date().toISOString(), id: findingId(node.id), run_id: runId, root, github, revision, method: node.id, path: node.path, name: node.qualified_name, line: node.line, end_line: node.end_line,
  hash: node.hash, risk: node.metrics?.risk_score ?? null, model: response.model, ...answers, callees: calleeIds, callers: callerIds });

/**
 * What a run narrowed by --paths or --since is about: a named file, or anything under a named directory. One definition, because
 * the walk and the report both ask it, and a report covering more than the run read is a report about somebody else's work.
 */
export const covers = (paths = []) => path => !paths.length || paths.some(item => path === item || path.startsWith(item.replace(/\/$/, '') + '/'));

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
 * the walk carries on, unless twice `parallel` fail in a row. The record is written after every reading.
 *
 * What a run covers is `paths`, which is a directory you named or what a branch changed. There is no cap on how many methods it
 * reads: a number that stops partway through leaves a report that looks complete and is not.
 */
/**
 * perch's own questions for a method, narrowed to its language and to the issue types this run asks about. A question raising
 * no issue comes along only when a kept one needs it, the way `kind` names a defect and `severity` ranks it. `perch check` asks
 * the same set, so a scan and a check of one method agree about what was asked.
 */
/** Questions about what a method's name and leading comment claim. A top-level unit has neither, so it is not asked them. */
const ABOUT_A_NAME = new Set(['does_what_it_claims', 'documented']);

export const methodQuestions = (kinds, language, { topLevel = false } = {}) => questionsFor(
  questionSet().filter(question => question.each === 'method' && !question.kind && appliesToLanguage(question, language)
    && !(topLevel && ABOUT_A_NAME.has(question.name))),
  [...kinds].map(value => ({ key: 'type', value })));

/**
 * The issue types a scan asks about. `scan_types` in `perch.yaml` decides; omitted, it is defects and rules.
 *
 * Refactor and docs read the same on every method that has ever been long. A scan of this repository reported 32 of them
 * against 0 defects, so the list a person opened was mostly rows they came for nothing. A filter naming one asks for it anyway,
 * since narrowing a report to a type you did not ask the questions for would report that you have none of them. That holds for
 * a kind or a rule as much as a type: `kind=sql_injection` asks the security question that raises it, or it asks nothing at all
 * and reports a clean run. Asked, they fail a run like anything else.
 */
export const typesAsked = (scanTypes, filters = [], questions = questionSet()) => {
  const naming = filters.filter(clause => clause.key === 'kind' || clause.key === 'rule');
  const named = naming.length ? questionsFor(questions, naming, kindLabel).filter(question => question.issue) : [];
  return new Set([
    ...(scanTypes ?? DEFAULT_TYPES),
    ...filters.filter(clause => clause.key === 'type').map(clause => clause.value),
    ...named.map(question => question.issue.type),
  ]);
};

export async function scanRepository({ root, revision, out, analyzer, systemOne, label = root, github = null, paths = [], named = [], parallel = DEFAULT_PARALLEL,
  unitParallel = UNIT_PARALLEL, min = 0.5, filters = [], onFile = () => {}, onFinding = () => {}, onProgress = () => {}, progress = () => {}, unitProgress = () => {}, searchProgress = () => {}, scanProgress = () => {}, log = () => {}, debug = () => {} }) {
  const store = openStore(out);
  // The whole tree is parsed however narrow the run is. Parsing is free next to a request, and a method's callers matter whether
  // or not they are in the diff: a graph cut down to what a branch touched cannot say who calls into it.
  const scan = await analyzeTree({ root, revision, out, analyzer, label, github, progress: scanProgress, log, debug });
  const graph = buildGraph(scan.files);
  const rules = asRules(await readRules(root, revision));
  // Which issue types this run asks about, and so which of perch's own questions ride in every request.
  const kinds = typesAsked(await readScanTypes(root, revision), filters);
  // --since and --paths say what this run reads, not what perch knows. A method outside is neither read nor reported here, and
  // what the last run said about it is carried onto the file at the end rather than dropped.
  // What perch.yaml says not to read at all, on top of what this run was asked to cover. A fixture kept so the docs can show real
  // output is code with a bug in every method on purpose, and being told about them on every run is noise nobody acts on.
  // `ignore` is about a scan of the repository. A path you named yourself, as the target or under --paths, is read even when a
  // glob covers it, the way `git add -f` adds an ignored file: `perch scan example/` reading nothing because example/** is
  // ignored told you the code was clean. A glob covering only part of what you named still applies inside it.
  const coversNamed = glob => named.some(path => matches(glob, path) || matches(glob, `${path.replace(/\/$/, '')}/file`));
  const ignored = (await readIgnored(root, revision)).filter(glob => !coversNamed(glob));
  const covered = covers(paths);
  const inScope = path => covered(path) && !ignored.some(glob => matches(glob, path));
  const candidates = scan.candidates.filter(candidate => graph.nodes.has(candidate.id) && inScope(graph.nodes.get(candidate.id).path));
  // How many methods the run was asked about that ignore took out, so a run left with none can say why rather than call it clean.
  const excluded = scan.candidates.filter(candidate => graph.nodes.has(candidate.id) && covered(graph.nodes.get(candidate.id).path)).length - candidates.length;
  // No methods in scope is an ordinary run, not a failure: a branch that only touched markdown and a workflow has none, and the
  // rules about files still cover what it did touch. Erroring here failed the run and skipped those rules as well.
  const candidateIds = candidates.map(candidate => candidate.id);
  const created = new Date().toISOString(), id = identity('scan', revision, created);
  const dir = store.runDir(id);
  const total = candidateIds.length;
  onProgress({ phase: 'reading', completed: 0, total, failed: 0 });
  const run = { id, status: 'running', target: label, github, root, revision, model: systemOne.id, paths, parallel, scan_id: scan.id, out: dir, created_at: created,
    methods: total, to_read: total, excluded, rules: rules.length, filters, edges: graph.edgeCount(), calls: 0, skipped: 0, checked: 0, visited: [], broken: [], failed: [], usage: { input_tokens: 0, output_tokens: 0 } };
  const saveRun = await store.startRun(run);

  // A file is reported the moment every method in it has been accounted for, rather than the run being held back to the end. A
  // method that could not be read counts: a file must not wait forever on one that will never arrive.
  // What the last run said, for the methods and questions this run does not cover. It is what the file keeps for those, not a
  // reason to skip asking about anything this run does cover: the endpoint caches answers, perch does not.
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
  const withClosure = finding => {
    const held = dismissals.get(finding.id);
    return held?.kinds.size ? { ...finding, closed: { kinds: [...held.kinds], at: held.at, reason: held.reason } } : finding;
  };
  const done = new Map();
  const finish = (path, event) => {
    done.set(path, [...(done.get(path) ?? []), event].filter(Boolean));
    if ((done.get(path).length + (missing.get(path) ?? 0)) < inFile.get(path).length) return;
    // What you have closed is decided here too, so a file reads the same as it streams past and in the list afterwards.
    onFile(path, done.get(path).map(withClosure));
  };
  const missing = new Map();

  const linesOf = createLineReader(root, graph), walk = createWalk(graph, candidates, inScope);
  const askedByMethod = new Map();
  const stepFor = async nodeId => {
    const node = graph.nodes.get(nodeId);
    const { calleeIds, callerIds, callees, callers, edges } = await methodNeighbours(graph, nodeId, linesOf);
    // Your rules about this method are asked in its request, beside perch's own. A method covered by five rules costs one reading,
    // not six.
    // A filter narrows what is asked, not just what is printed. Asking thirty questions about a method to print two is paying
    // for twenty-eight answers nobody reads, and a method no kept question covers is not read at all.
    const asked = questionsFor([...methodQuestions(kinds, node.language, { topLevel: Boolean(node.lines) }), ...rulesForMethod(rules, node)], filters, kindLabel);
    askedByMethod.set(node.id, asked);
    const own = asked.filter(question => question.kind);
    if (!asked.length) return { node, calleeIds, callerIds, rules: own, skip: true };
    const lines = await linesOf(node);
    const prepare = budget => methodSteps({ node, lines, callees, callers, edges, asked, budget });
    const steps = prepare(systemOne.limits?.state);
    return { node, calleeIds, callerIds, rules: own, steps, prepare };
  };
  const ask = async nodeId => {
    const { node, calleeIds, callerIds, rules: own, steps, prepare, skip } = await stepFor(nodeId);
    if (skip) return { node, calleeIds, callerIds, rules: own, skipped: true };
    const { response, answers } = await questionMethod({ systemOne, node, steps, prepare, rules: own, debug });
    return { node, calleeIds, callerIds, rules: own, response, answers };
  };
  /** Every reading this run made. The file is written whole at the end, so what this run did not cover is carried onto it. */
  const read = [], broken = [];
  const record = async results => {
    for (const { node, calleeIds, callerIds, rules: own, response, answers, skipped } of results) {
      // A filter narrows which questions are asked, not which code the run is about, so what it did not ask about is what the
      // last run said rather than nothing at all. Rewriting the file whole with only the answers this run happened to want threw
      // away every other answer on the same method.
      const before = filters.length ? earlier.get(node.id) : null;
      if (skipped) { run.skipped++; if (before) read.push(before); continue; }
      run.calls++;
      run.usage.input_tokens += response?.usage?.input_tokens ?? 0; run.usage.output_tokens += response?.usage?.output_tokens ?? 0;
      const fresh = readEvent({ node, answers, response, runId: id, root, github, revision, calleeIds, callerIds });
      const event = before ? { ...before, ...fresh } : fresh;
      read.push(event); run.visited.push({ ...event, status: 'read' });
      onFinding(withClosure(event));
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

  // Once the run has failed, nothing more is asked: a method still in flight comes back to nobody, and a rule about a file is
  // refused before it is sent. The rules about files are asked on a view of the service that checks this first, since askUnits has no
  // other way to be told the walk it runs beside has stopped.
  let halted = null, landing = Promise.resolve();
  const gated = Object.create(systemOne, { ask: { value: (...args) => halted ? Promise.reject(halted) : systemOne.ask(...args) } });
  try {
    // Said once before anything is asked. A counter that only moves when an answer arrives shows the phase before it, frozen,
    // for as long as the first request takes, which on a service that is retrying is a long time and reads as a hang.
    progress(0, total);
    // The rules about files and the searches start now, beside the walk rather than after it. They read the tree, the graph and
    // the rules, all settled before the first method is asked, and nothing a reading adds: a finding is written once at the
    // end, and neither the methods nor the rules about files wait on the other. Waiting for the last method only made a run the
    // length of both. The tree is only read when a file rule or a search is in the set; all rules, not the filtered ones, since a
    // rule filtered out is still counted in coverage, and counting a file rule's units needs the tree.
    const files = new Map();
    let tree = [];
    const kept = new Set(questionsFor(rules, filters, kindLabel).map(rule => rule.name));
    const asking = rules.filter(rule => kept.has(rule.name));
    const checking = (async () => {
      if (rules.some(rule => SEARCHES(rule.kind) || rule.each !== 'method')) {
        for (const file of scan.files) files.set(file.path, (await linesOf({ id: file.path, path: file.path })).join('\n'));
        tree = await listTree(root, revision);
        const eligible = createFileSelector(tree);
        for (const item of tree) if (eligible(item) && !files.has(item.path)) files.set(item.path, await readBlob(root, item.sha).catch(() => ''));
      }
      // What is left is every rule that is not about a method, and every claim about the codebase rather than about one file. The
      // source they are asked about comes from the revision, not from disk, so a finding is still about a commit.
      const over = { scan, graph, files, tree, revision, systemOne: gated, inScope, min, debug };
      return Promise.all([
        askUnits({ ...over, rules: asking.filter(rule => !SEARCHES(rule.kind) && rule.each !== 'method'), parallel: unitParallel, progress: unitProgress }),
        searchUnits({ ...over, rules: asking.filter(rule => SEARCHES(rule.kind)), parallel: unitParallel, progress: searchProgress }),
      ]);
    })();

    // Up to `parallel` methods in flight, and the next one sent the moment any of them lands, so one slow reply holds up one slot
    // rather than every other. A reading is recorded before the next method is taken off the walk, because what it says
    // decides what that is: its callees, its callers, the neighbor it points at and the rest of its file go on top. Recording is
    // one at a time, in the order answers arrive, since two at once would push onto the walk and append to the journal together.
    const reading = new Promise((resolve, reject) => {
      let flying = 0, settled = 0, landed = 0, inARow = 0;
      const stop = error => { halted ??= error; reject(error); };
      const land = async (nodeId, outcome) => {
        if (halted) return;
        if (outcome.failed) {
          const { failed } = outcome;
          run.failed.push(failed); run.visited.push(failed);
          missing.set(failed.path, (missing.get(failed.path) ?? 0) + 1);
          finish(failed.path, null);
        }
        // Counted in the order answers arrive: a slot that keeps failing while its neighbors answer is one bad method, and every
        // slot failing is a key or a service the rest of the repository will not fix.
        inARow = outcome.failed ? inARow + 1 : 0;
        if (inARow >= parallel * 2) throw new Error(`${inARow} methods in a row could not be read; last error: ${run.failed.at(-1)?.error ?? 'unknown'}`);
        if (!outcome.failed) await record([outcome]);
        await saveRun();
        landed++;
        onProgress({ phase: 'reading', completed: landed, total, failed: run.failed.length });
      };
      const fill = () => {
        if (halted) return;
        while (flying < parallel) {
          const nodeId = walk.next(); if (!nodeId) break;
          walk.visited.add(nodeId); flying++;
          ask(nodeId).then(result => result, error => {
            if (error instanceof AuthenticationError) throw error;
            const node = graph.nodes.get(nodeId); log(`${node.qualified_name} in ${node.path}: ${error.message}`);
            return { failed: { method: nodeId, id: findingId(nodeId), path: node.path, name: node.qualified_name, line: node.line, status: 'failed', error: error.message, incomplete: error instanceof IncompleteCheckError } };
          }).then(outcome => {
            if (halted) return;
            progress(++settled, total);
            // Queued when the answer arrives, not when the method was sent, so a slow reply is written down when it comes and
            // does not hold the queue for the ones behind it. The slot is given back once the answer is written down, not when
            // it arrives, so the next pick sees what it enqueued.
            landing = landing.then(() => land(nodeId, outcome)).then(() => { flying--; fill(); });
            return landing;
          }).catch(stop);
        }
        // The walk is empty only when nothing is still in flight: an answer yet to arrive can put its neighbors on it.
        if (!flying) resolve();
      };
      fill();
    });
    // Both at once, so a file rule that fails its key stops the walk as surely as a method that does, and the other way round.
    const [, [units, searches]] = await Promise.all([
      reading.then(() => onProgress({ phase: 'checking', completed: walk.visited.size, total, failed: run.failed.length })),
      checking,
    ]);
    run.failed.push(...[...units.results, ...searches.results].filter(result => result.error));
    // Every attempt failed and none answered. The in-a-row check above only fires after twice `parallel`, so a pull request that
    // touched three methods ran through an outage and came back clean. Nothing read is not nothing found, however small the run.
    // Code that cannot fit a request at any token budget is incomplete rather than failed: that is the code, not perch being
    // unable to run.
    const answered = run.calls + [...units.results, ...searches.results].filter(result => !result.error).length;
    const failures = run.failed.filter(result => result.incomplete !== true && !result.oversize);
    if (failures.length && !answered) throw new Error(`nothing could be read: ${failures.length} failed; last error: ${failures.at(-1).error}`);
    run.incomplete = [
      ...run.failed.filter(result => result.incomplete === true).map(result => `${result.path}::${result.name}: ${result.error}`),
      ...[...units.results, ...searches.results].filter(result => result.incomplete).map(result => result.incomplete),
    ];
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
        name: question.name, from: 'builtin', where: question.where,
        units: [...askedByMethod.values()].filter(asked => asked.some(item => item.name === question.name)).length,
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
    run.checked = [...askedByMethod.values()].reduce((total, asked) => total + asked.length, 0) + units.asked + searches.asked;

    // What this run did not cover. --paths and --since say which code a run is about, and --filter says which questions it asks;
    // neither says the rest of the repository stopped existing. Writing the file with only what this run touched threw away
    // every reading outside it, so `perch scan --paths one/file.js` left a store that knew about one file.
    const walked = new Set(read.map(event => event.method));
    const elsewhere = [...earlier.values()].filter(event => !walked.has(event.method) && graph.nodes.has(event.method));
    // Rule checks are carried the same way, and only while the rule that produced one is still that rule. A rule reworded,
    // reshaped or deleted since leaves a check describing a question that no longer exists. The unit has to be the same too: a
    // test deleted or moved, a file removed, or a comment rewritten leaves a check about text this tree does not hold. A search
    // that found nothing is about the rule and not a unit, so it stands on the rule alone.
    const said = new Set(broken.map(check => check.id));
    const byName = new Map(rules.map(rule => [rule.name, rule]));
    const blobs = new Map(tree.map(item => [item.path, item.sha]));
    const unasked = [...checks.values()].filter(check => !said.has(check.id) && byName.get(check.rule)?.hash === check.rule_hash
      && (String(check.unit).startsWith('search:') || unitHash(check, { graph, files, blobs }) === check.hash));
    await store.recordScan([...read, ...elsewhere, ...broken, ...unasked]);
    run.remaining = walk.remaining(); run.status = run.incomplete.length ? 'incomplete' : 'complete'; run.completed_at = new Date().toISOString();
    await saveRun(true); await store.prune('runs', id).catch(error => log(`Could not remove earlier runs: ${error.message}`)); return run;
  } catch (error) { halted ??= error; await landing.catch(() => {}); run.status = 'failed'; run.error = error.message; await saveRun(true).catch(() => {}); await store.prune('runs', id).catch(prune => log(`Could not remove earlier runs: ${prune.message}`)); throw error; }
}
