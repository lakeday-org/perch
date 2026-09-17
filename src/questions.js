/** The state one method is asked over, the questions perch adds to whatever the question set declares, and how answers are read. */
import { compile, floorFor, issues, questionSet, readAnswer, setHash, vocabulary } from './ask.js';

/** The bands a severity score is named by, worst last, matching the rubric declared in the question set. */
export const SEVERITY_BANDS = ['P3', 'P2', 'P1', 'P0'];

/**
 * Where the score actually lands, on the P scale the bands are written in. A score carries its whole distribution, and naming a
 * method by the band holding the most of it throws that away: a spread of 33/31/30/6 is called P0 on the strength of a third of
 * the mass, and reads as worse than a method with 54% on P1 and 29% on P0 that is in fact expected to do more damage.
 *
 * So the rubric's mean is what a method is called. The rubric runs 0 (no caller would notice) to 3 (data lost or a check
 * bypassed) and the bands run P3 to P0, so a mean of 2.1 is P0.9: nearly as bad as it gets, and visibly worse than the P1.1
 * beside it. The band a method files under is that number rounded, and `likeliest` is still the single band holding the most.
 */
export function severityOf(severity) {
  const probabilities = severity?.probabilities;
  if (!probabilities) return severity?.level ? { band: severity.level, likeliest: severity.level, predicted: null, probability: null, expected: null } : null;
  const entries = Object.entries(probabilities).map(([level, p]) => [Number(level), p]);
  const [likeliest, probability] = entries.sort((a, b) => b[1] - a[1])[0];
  const expected = entries.reduce((total, [level, p]) => total + level * p, 0);
  return { band: SEVERITY_BANDS[Math.round(expected)] ?? SEVERITY_BANDS[likeliest], likeliest: SEVERITY_BANDS[likeliest] ?? String(likeliest),
    predicted: 3 - expected, probability, expected };
}
/** Two rows compare without either being opened, which the band alone does not let them do. */
export const severityName = severity => { const score = severityOf(severity); return !score ? '-' : score.predicted === null ? score.band : `${score.band} (${score.predicted.toFixed(1)})`; };
/** The band a method files under, which is what `--filter severity=` reads. */
export const severityBand = severity => severityOf(severity)?.band ?? '-';

/** The strongest vulnerability the answers support, already discounted by whatever each class is gated on. */
export function securityOf(answers, questions = questionSet()) {
  const found = issues(answers, 0, questions, label).find(issue => issue.type === 'security');
  return found ? { kind: found.label, probability: found.probability } : null;
}

/** Every vulnerability class and how likely it is, for a detail view that shows the whole distribution rather than the winner. */
export const securities = (answers, questions = questionSet()) =>
  Object.fromEntries(questions.filter(question => question.issue?.type === 'security' && answers[question.name] !== undefined)
    .map(question => [label(question.name), answers[question.name] * (question.when ? answers[question.when] ?? 1 : 1)]));

/**
 * How a class is displayed, where that differs from the name it is declared under in the question set. A label is written the way
 * `--filter` takes it, underscores and all, so what a row shows is what you can type back at the command: `too_big 78%` is
 * filtered with `--filter kind=too_big`.
 */
export const KIND_LABELS = { boundary: 'off_by_one', missing_null_handling: 'unhandled_null', wrong_return: 'wrong_return_value', swallowed_error: 'error_ignored', state_mutation: 'bad_state_change', ordering: 'wrong_order', resource_leak: 'leak', inverted_condition: 'inverted_condition',
  split: 'too_big', flatten: 'too_nested', simplify_conditions: 'tangled_conditions', deduplicate: 'duplicated_logic', rename: 'misnamed', remove_dead_code: 'dead_code', none: 'none' };
export const label = kind => KIND_LABELS[kind] ?? kind;

const percent = value => `${Math.round(value * 100)}%`;
/**
 * The floor an issue has to clear to be worth printing. Half is not a number picked to make the list a nice length: a noul is the
 * probability that something is true, so above a half is the model saying yes and below it is the model saying no. Listing
 * everything means listing every method in the repository, because no answer ever comes back at exactly zero.
 *
 * It is a floor on what is *shown*, not on the arithmetic. Ranking still counts the whole distribution, so an issue at 49% still
 * weighs 0.49 in where its method sorts, and there is no cliff at the boundary — only a line below which perch stops claiming to
 * have found something. `--min` moves it.
 */
export const BELIEVED = 0.5;
/** A method whose tree-sitter risk score is at least this carries a `complex` issue, whether or not System One has read it. */

/**
 * Every issue a method carries, strongest first. Where two answers are both needed for a problem to be real they multiply: a
 * vulnerability that needs outside input is its class times the chance anything from outside reaches the method. Where one answer
 * is the problem and another only names it, the naming answer does not discount it. Nothing is filtered out: an issue at 8% is
 * listed as 8% and sorts to the bottom, where it belongs.
 */
export function issuesOf(answers, min = BELIEVED, questions = questionSet()) {
  const found = issues(answers, min, questions, label);
  // A broken rule arrives as a finding of its own rather than as answers, since it may be about a file with no methods at all,
  // and a report of it must read the same whether or not the rule is still in the set that declared it.
  if (answers.lint) {
    const rule = questions.find(question => question.name === answers.lint.rule);
    const floor = floorFor(rule, min);
    if (answers.lint.broken > floor) {
      found.push({ type: 'lint', label: answers.lint.rule, probability: answers.lint.broken, floor, text: `${answers.lint.rule} ${percent(answers.lint.broken)}` });
      found.sort((a, b) => b.probability - a.probability);
    }
  }
  // What you have closed is not what the scan found, it is what you decided about it, so it comes off here rather than at the
  // point of printing: a closed kind must not rank a method either.
  const closed = new Set(answers.closed?.kinds ?? []);
  return closed.size ? found.filter(issue => !closed.has(issue.label)) : found;
}

/**
 * Every answer contributes its own probability, so two at 50% weigh what one at 100% weighs and nothing has to cross a line to
 * count. The two sides are apart because only correctness is multiplied by the severity rubric, and design weighs as itself.
 */
export function expectedIssues(answers, issues = issuesOf(answers, 0)) {
  const sum = list => list.reduce((total, issue) => total + issue.probability, 0);
  return { correctness: sum(issues.filter(issue => !isDesign(issue))), design: sum(issues.filter(isDesign)) };
}

/**
 * What a method is ranked by: how much trouble it is expected to cause, not how many things are wrong with it. A correctness
 * problem weighs what the severity rubric measured for this method, taken from the whole distribution rather than the band it
 * landed on, so a method that would lose data outranks one that would return a wrong number however many notes it also carries.
 * Design problems weigh as themselves: they are the ones the rubric's own bottom level describes, the ones no caller notices.
 */
export const issueWeight = answers => {
  const { correctness, design } = expectedIssues(answers);
  return correctness * (severityOf(answers.severity)?.expected ?? 1) + design;
};
/**
 * What `--filter` understands, read from the questions themselves, so `perch issues --types` prints what this repository can
 * actually raise and a typo is answered with the real list. A question set with a class added has it here without anything
 * being told about it twice.
 */
export const filterKeys = (questions = questionSet()) => {
  const { types, labels } = vocabulary(questions, label);
  // `lint` is a type no question in the set declares: a rule raises it, and a rule may be added between a run and a report of it.
  return { type: [...new Set([...types, 'lint'])], kind: labels, severity: [...SEVERITY_BANDS] };
};

const canon = value => String(value).trim().toLowerCase().replace(/[_-]+/g, ' ');
/**
 * Words that name a type without being the name it is filed under. A defect is a bug, and typing the word everyone uses should
 * not be a mistake to correct. This reads input and nothing else: a row still prints the one name the type has, so there is one
 * name for the thing and one spelling of it in anything a pipe reads.
 */
const ALSO_KNOWN = { bug: 'defect' };
export const meaning = value => ALSO_KNOWN[canon(value)] ?? canon(value);
/** The other words for a type, so a listing of what a filter takes can say them rather than let you find out by being wrong. */
export const alsoKnownAs = type => Object.keys(ALSO_KNOWN).filter(word => ALSO_KNOWN[word] === type);
/** How much of the score's mass sits in the band the method files under: how sure the filter's answer is. */
const bandWeight = severity => severity?.probabilities?.[SEVERITY_BANDS.indexOf(severityBand(severity))] ?? 1;

/** `type=security,kind=too big` as a list of tests; an unknown key or value is an error naming what is allowed. */
export function parseFilters(text) {
  const keys = filterKeys(), filters = [];
  for (const clause of String(text).split(',').map(part => part.trim()).filter(Boolean)) {
    const [key, ...rest] = clause.split('=');
    const name = canon(key), value = name === 'type' ? meaning(rest.join('=')) : canon(rest.join('='));
    if (!Object.hasOwn(keys, name)) throw new Error(`unknown filter "${key.trim()}"; filter on ${Object.keys(keys).join(', ')}`);
    if (!rest.length || !value) throw new Error(`filter ${name} needs a value: one of ${keys[name].join(', ')}`);
    const allowed = keys[name].map(canon);
    if (!allowed.includes(value)) throw new Error(`${name} "${rest.join('=').trim()}" is not one of ${keys[name].join(', ')}`);
    filters.push({ key: name, value });
  }
  return filters;
}

/** A finding matches when every clause is true of it; clauses on the same key are alternatives. */
export function matchesFilters(finding, filters, min = 0.5) {
  if (!filters.length) return true;
  const issues = issuesOf(finding, min);
  const byKey = new Map();
  for (const { key, value } of filters) byKey.set(key, [...(byKey.get(key) ?? []), value]);
  for (const [key, values] of byKey) {
    const ok = key === 'severity' ? values.includes(canon(severityBand(finding.severity))) && issues.some(issue => issue.type === 'defect')
      : key === 'type' ? issues.some(issue => values.includes(issue.type))
      : issues.some(issue => values.includes(canon(issue.label)));
    if (!ok) return false;
  }
  return true;
}

/**
 * How sure the filter is about a finding it kept: clauses on one key are alternatives, so the likeliest of them speaks for the
 * key, and clauses on different keys must all hold, so they multiply. `--filter type=security` then ranks by the chance the
 * method really is vulnerable rather than by whatever else it happens to be carrying. Unfiltered, there is nothing to rank by.
 */
export function filterStrength(finding, filters) {
  if (!filters.length) return null;
  const issues = issuesOf(finding);
  const byKey = new Map();
  for (const { key, value } of filters) byKey.set(key, [...(byKey.get(key) ?? []), value]);
  let joint = 1;
  for (const [key, values] of byKey) {
    const likeliest = key === 'severity'
      ? (values.includes(canon(severityBand(finding.severity))) ? bandWeight(finding.severity) * (finding.has_bug ?? 0) : 0)
      : issues.filter(issue => values.includes(key === 'type' ? issue.type : canon(issue.label))).reduce((top, issue) => Math.max(top, issue.probability), 0);
    joint *= likeliest;
  }
  return joint;
}

/**
 * A finding's issues, the ones a filter named first. Filtering narrows the list and ranks it by the problem asked for, so the row
 * has to read that way too: `--filter type=security` on a method whose loudest problem is its size must still show the
 * vulnerability, or the row contradicts the filter that selected it. A severity clause names the defect, since that is the
 * question severity is asked about. Order within each group is unchanged, so the likeliest still comes first.
 */
export function issuesFor(finding, min = 0, filters = []) {
  const issues = issuesOf(finding, min);
  if (!filters.length) return issues;
  const named = issue => filters.some(({ key, value }) => (key === 'type' ? issue.type === value : key === 'kind' ? canon(issue.label) === value : issue.type === 'defect'));
  return [...issues.filter(named), ...issues.filter(issue => !named(issue))];
}

export const isDesign = issue => issue.type !== 'defect' && issue.type !== 'security';
/** Design problems do not count here: a method nobody can break is not flagged for being ugly. */
export const flagged = (answers, min = 0) => issuesOf(answers, min).some(issue => !isDesign(issue));
/** The complement of flagged, so a method with neither is one the scan has nothing to say about. */
export const needsDesign = (answers, min = 0) => issuesOf(answers, min).some(isDesign);
export const hasIssue = (answers, min = 0) => issuesOf(answers, min).length > 0;

export const MAX_CALLEES = 8, MAX_CALLERS = 8, STATE_BUDGET = 48 * 1024, MODULE_SCOPE_BUDGET = 6 * 1024;
/**
 * What the generating model is shown. Far more than System One gets, and deliberately: a `read` call costs a round trip and
 * seconds of the model's own thinking, so a neighbor cut off at eighty lines buys a few thousand tokens and pays for them with
 * a turn spent fetching the rest. Whole methods, up to a quarter of a megabyte.
 */
export const FIX_STATE_BUDGET = 256 * 1024, FIX_LIMITS = [Infinity, 400, 160, 80, 40], FIX_NEIGHBOURS = 24;
/** A Choice accepts at most 255 options; past that, pick a window then the line inside it. */
export const MAX_CHOICES = 255;
export const lineId = line => `L${String(line).padStart(4, '0')}`;
const windowId = index => `W${String(index + 1).padStart(4, '0')}`;
const addUsage = (a, b) => !b ? a : { input_tokens: (a?.input_tokens ?? 0) + (b.input_tokens ?? 0), output_tokens: (a?.output_tokens ?? 0) + (b.output_tokens ?? 0) };

/** Blanks and comments are dropped so the model cannot point at a line no defect could live on. */
export function codeLineIds(lines, start, end) {
  const ids = [];
  for (let line = start; line <= end; line++) {
    const text = lines[line - 1] ?? '';
    if (!text.trim() || commentLine.test(text)) continue;
    ids.push(lineId(line));
  }
  return ids.length ? ids : [lineId(start)];
}

/** Split line ids into even windows of at most `limit` when a single Choice cannot name them all. */
export function lineWindows(ids, limit = MAX_CHOICES) {
  if (ids.length <= limit) return null;
  const count = Math.ceil(ids.length / limit);
  const size = Math.ceil(ids.length / count);
  return Array.from({ length: count }, (_, index) => ids.slice(index * size, (index + 1) * size)).filter(window => window.length);
}

export const whereQuestion = ids => ({ type: 'choice', instructions: 'Which line of `method` is the defect on? If there is no defect, pick the line most likely to hide one.', criteria: Object.fromEntries(ids.map(id => [id, null])) });
export const whereWindowQuestion = windows => ({ type: 'choice', instructions: 'Which span of `method` contains the defect? If there is no defect, pick the span most likely to hide one.',
  criteria: Object.fromEntries(windows.map((ids, index) => [windowId(index), `${ids[0]}–${ids.at(-1)}`])) });

/** A Choice holds 255 options, so a longer method costs a second request: pick the span, then the line inside it. */
export async function locateWhere({ systemOne, state, questions, windows }) {
  const first = await systemOne.ask(state, questions);
  if (!windows) return first;
  const index = Math.max(0, Number(String(first.answers.where_window?.choice ?? windowId(0)).slice(1)) - 1);
  const second = await systemOne.ask(state, { where: whereQuestion(windows[index] ?? windows[0]) });
  return { ...first, answers: { ...first.answers, ...second.answers }, usage: addUsage(first.usage, second.usage) };
}
export const tagged = (lines, start) => lines.map((text, index) => `${lineId(start + index)}| ${text}`).join('\n');
/** A method's source, or a window of `limit` lines from it; when a `focus` line is given (a call site) the window is centered there so the call is visible. */
const excerpt = (lines, start, end, limit, focus = null) => {
  const slice = lines.slice(start - 1, end);
  if (slice.length <= limit) return tagged(slice, start);
  const from = focus === null ? 0 : Math.min(Math.max(0, focus - start - Math.floor(limit / 2)), slice.length - limit);
  const shown = tagged(slice.slice(from, from + limit), start + from);
  return `${from ? `... (${from} lines above)\n` : ''}${shown}${from + limit < slice.length ? `\n... (${slice.length - from - limit} more lines)` : ''}`;
};
const short = id => id.split('::').at(-1);
const commentLine = /^\s*(\/\/|\/\*|\*|#|"""|''')/;
/** A method's contract is written above it, not inside it, so any question about documentation has to reach up for it. */
export function leadingComment(lines, line) {
  const block = [];
  for (let index = line - 2; index >= 0 && (commentLine.test(lines[index]) || (block.length && !lines[index].trim())); index--) block.unshift(lines[index]);
  return block.join('\n').trim();
}

/**
 * Without this, an identifier that is neither a callee nor an import is a name the model has to guess at. Cut at `budget` bytes,
 * because a file's constants are worth less to the reading than its callers are.
 */
export function moduleScope(lines, methods, budget = MODULE_SCOPE_BUDGET) {
  const inside = new Set();
  for (const method of methods) for (let line = method.line; line <= method.end_line; line++) inside.add(line);
  const kept = [];
  let size = 0;
  for (let line = 1; line <= lines.length; line++) {
    const text = lines[line - 1];
    if (inside.has(line) || !text.trim() || commentLine.test(text) || /^\s*(import|from|use|package)\b/.test(text)) continue;
    const entry = `${lineId(line)}| ${text}`;
    if (size + entry.length > budget) { kept.push(`... (cut at ${budget} bytes)`); break; }
    kept.push(entry);
    size += entry.length + 1;
  }
  return kept.join('\n') || null;
}

/**
 * The state and questions for one method.
 * `node` is the graph node and `lines` its file's lines. `imports` are the file's import records; `methods` the file's method records,
 * so the module scope around them can be shown. `callees` and `callers` are [{ node, lines, site, calls }] with the neighbor's file
 * lines, the calling line (callers), and the names of the neighbor's own callees (second hop). `edges` are ["a -> b"] strings.
 */
export function methodStep({ node, lines, imports = [], methods = [node], callees, callers, edges = [], budget = STATE_BUDGET, limits = [40, 20, 8, 3], maxCallees = MAX_CALLEES, maxCallers = MAX_CALLERS, asked = questionSet().filter(question => question.each === 'method') }) {
  const build = (limit, own = Infinity, scope = true) => ({
    method: { path: node.path, name: node.qualified_name, leading_comment: leadingComment(lines, node.line) || null, metrics: node.metrics ?? null,
      source: excerpt(lines, node.line, node.end_line, own) },
    imports: imports.map(item => `${item.name}${item.alias !== item.name ? ` as ${item.alias}` : ''} from ${item.module}`),
    module_scope: scope ? moduleScope(lines, methods) : null,
    calls: callees.slice(0, maxCallees).map(({ node: callee, lines: calleeLines, calls = [] }) =>
      ({ id: callee.id, name: callee.qualified_name, path: callee.path, source: excerpt(calleeLines, callee.line, callee.end_line, limit), calls: calls.map(short) })),
    called_by: callers.slice(0, maxCallers).map(({ node: caller, lines: callerLines, site, handover = false }) =>
      ({ id: caller.id, name: caller.qualified_name, path: caller.path,
        ...(handover
          ? { hands_method_on_at: site ?? null, note: 'this caller does not call the method here: it passes it on to be called later, so the call itself is not in view' }
          : { calls_method_at: site ?? null }),
        source: excerpt(callerLines, caller.line, caller.end_line, limit, site ?? null) })),
    call_graph: edges,
  });
  const over = () => JSON.stringify(state).length > budget;
  let state = build(limits[0] === Infinity ? Infinity : 80);
  for (const limit of limits) { if (!over()) break; state = build(limit); }
  // A method can be big enough on its own that no amount of trimming its neighbors helps. Drop the module scope, then work out
  // how many of its lines fit in what is left rather than guessing: the rest is read in the next pass, so every line here is one
  // fewer request. A request that cannot be sent reads nothing at all.
  if (over()) {
    state = build(limits.at(-1), Infinity, false);
    if (over()) {
      const count = node.end_line - node.line + 1;
      const perLine = Math.max(1, Math.ceil(state.method.source.length / count));
      const room = budget - (JSON.stringify(build(limits.at(-1), 0, false)).length + 64);
      let own = Math.max(MIN_PASS_LINES, Math.floor(room / perLine));
      state = build(limits.at(-1), own, false);
      // The estimate is an average over lines that are not all the same length, so close the gap rather than trust it.
      while (over() && own > MIN_PASS_LINES) { own = Math.max(MIN_PASS_LINES, Math.floor(own * 0.8)); state = build(limits.at(-1), own, false); }
    }
  }
  const { calls, called_by: calledBy } = state;
  const neighbors = [...calls, ...calledBy].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
  // Only lines the model can see are lines it can point at: a trimmed method must not be asked about the part that was cut.
  const shown = [...state.method.source.matchAll(/^L(\d+)\|/gm)].map(match => Number(match[1]));
  const visible = new Set(shown.map(line => lineId(line)));
  const lineIds = codeLineIds(lines, node.line, node.end_line).filter(id => visible.has(id));
  const windows = lineWindows(lineIds);
  // The questions themselves are declared, not written here: what perch asks of a method is data, so a repository can reword a
  // class or add one without this function hearing about it. What stays is what is not a question about your code — which line
  // the defect is on, and which method to read next — because both are built from this method's own neighbourhood.
  const questions = {
    ...compile(asked),
    ...(windows ? { where_window: whereWindowQuestion(windows) } : { where: whereQuestion(lineIds) }),
    follow: { type: 'choice', instructions: 'Which related method most likely holds or reveals a defect connected to `method`, and is worth examining next?',
      criteria: { ...Object.fromEntries(neighbors.map(item => [item.id, `${item.name} in ${item.path}`])), none: 'No related method is worth following' } },
  };
  for (const [index, call] of calls.entries())
    questions[`misuse_${index}`] = { type: 'noul', instructions: { callee: call.id, question: 'Does `method` call `callee` in a way that violates the contract evident from the callee\'s source: wrong argument order, type, or shape, an unchecked result, or an ignored error?' },
      criteria: { true: 'At least one call from method to callee breaks what the callee visibly expects or returns', false: 'Every call matches what the callee expects and handles what it returns' } };
  for (const [index, caller] of calledBy.entries())
    questions[`misused_by_${index}`] = { type: 'noul', instructions: { caller: caller.id, question: 'Does `caller` call `method` in a way that violates the contract evident from the method\'s source, or rely on behavior the method does not guarantee?' },
      criteria: { true: 'The caller passes something the method does not handle, or depends on a result or side effect the method does not reliably provide', false: 'The caller uses the method as its source intends' } };
  return { state, questions, asked, calls, calledBy, neighbors, windows, covers: { line: shown[0] ?? node.line, end_line: shown.at(-1) ?? node.end_line } };
}

/** Lines of a method repeated at the start of the next pass, so a defect spanning the seam is in one pass whole. */
export const PASS_OVERLAP = 20;
/** However tight the budget, a pass this short is not worth a request. */
const MIN_PASS_LINES = 40;
/** Passes one method is worth. A method needing more than this is pathological, and its size is the finding. */
export const MAX_PASSES = 8;

/**
 * One method as the passes it takes to read it. Most methods are one pass. A method too long to send in a single request used to
 * be cut to its head, which reads 300 lines of a 20,000-line method and answers as if that were the method; instead it is read in
 * overlapping passes until it runs out or hits `MAX_PASSES`. Only the first pass carries the neighborhood, since the callers and
 * callees are about the method, not about a slice of it.
 */
export function methodSteps({ node, lines, imports = [], methods = [node], callees = [], callers = [], edges = [], ...options }) {
  const steps = [];
  let start = node.line;
  while (start <= node.end_line && steps.length < MAX_PASSES) {
    const first = !steps.length;
    const step = methodStep({ node: { ...node, line: start }, lines, imports: first ? imports : [], methods,
      callees: first ? callees : [], callers: first ? callers : [], edges: first ? edges : [], ...options });
    steps.push(step);
    if (step.covers.end_line >= node.end_line) break;
    const next = Math.max(step.covers.end_line - PASS_OVERLAP + 1, start + 1);
    if (next <= start) break;
    start = next;
  }
  return steps;
}

/**
 * Typed answers reduced to what the walk and the log use. Every declared question is kept under its own name, whatever it is, so
 * a class added to the question set is recorded without this function being told. The rest are the machinery's own answers: where
 * the defect is, which method to read next, and what the neighbours look like from here.
 */
export function readAnswers(answers, { calls, calledBy, neighbors, asked = questionSet().filter(question => question.each === 'method') }) {
  const follow = answers.follow.choice;
  const read = { answers_set: setHash(asked) };
  for (const question of asked) read[question.name] = readAnswer(question, answers[question.name]);
  return {
    ...read,
    where: { line: Number(answers.where.choice.slice(1)), confidence: answers.where.confidence },
    severity: { ...read.severity, level: severityOf(read.severity)?.band ?? null, predicted: severityOf(read.severity)?.predicted ?? null },
    misuse: calls.map((call, index) => ({ callee: call.id, probability: answers[`misuse_${index}`].noul })),
    misused_by: calledBy.map((caller, index) => ({ caller: caller.id, probability: answers[`misused_by_${index}`].noul })),
    follow: { method: neighbors.some(item => item.id === follow) ? follow : null, confidence: answers.follow.confidence, probabilities: answers.follow.probabilities },
  };
}
