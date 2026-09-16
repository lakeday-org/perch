/** The questions one hunt step asks about a method, the state they are asked over, and how the answers are read. */

export const DEFECT_KINDS = {
  boundary: 'An off-by-one, a wrong comparison, or a mishandled edge of a range',
  missing_null_handling: 'A null, undefined, empty, or absent value is not handled',
  wrong_return: 'The wrong value, or a value of the wrong shape, is returned for some input',
  swallowed_error: 'An error is caught, ignored, or turned into a misleading result',
  state_mutation: 'Shared or input state is mutated when it should not be, or left stale when it should change',
  ordering: 'Operations run in the wrong order, or rely on an order that is not guaranteed',
  resource_leak: 'A handle, lock, timer, process, or connection is not released on some path',
  inverted_condition: 'A condition, sign, or boolean is the wrong way round',
};

export const REFACTORS = {
  split: 'Does too many things; split it into smaller methods with one job each',
  flatten: 'Nested too deeply; flatten with early returns or extracted helpers',
  simplify_conditions: 'Conditions are hard to follow; simplify or name them',
  deduplicate: 'Repeats logic that exists elsewhere in the shown code; reuse it',
  rename: 'The name or parameters misdescribe what it does; rename them',
  remove_dead_code: 'Contains unreachable or unused code; remove it',
  none: 'No refactor needed',
};

export const SEVERITY_LEVELS = ['Cosmetic: no caller would notice', 'Minor: a wrong result in a rare or recoverable case', 'Major: a wrong result or state in normal use', 'Critical: data loss, corruption, a crash, or a security impact'];
export const SEVERITY_NAMES = ['cosmetic', 'minor', 'major', 'critical'];

/** Plain names for the defect kinds and refactors, for anything a person reads. */
export const KIND_LABELS = { boundary: 'off by one', missing_null_handling: 'unhandled null', wrong_return: 'wrong return value', swallowed_error: 'error ignored', state_mutation: 'bad state change', ordering: 'wrong order', resource_leak: 'leak', inverted_condition: 'inverted condition',
  split: 'too big', flatten: 'too nested', simplify_conditions: 'tangled conditions', deduplicate: 'duplicated logic', rename: 'misnamed', remove_dead_code: 'dead code', none: 'none' };
export const label = kind => KIND_LABELS[kind] ?? kind.replaceAll('_', ' ');
const spaced = label;

const percent = value => `${Math.round(value * 100)}%`;
/** A method whose tree-sitter risk score is at least this carries a `complex` issue, whether or not System One has read it. */
export const COMPLEX_RISK = 70;

/**
 * Every issue a method carries at probability `min` or more, strongest first. A defect needs `has_bug` and, when asked, `reachable`;
 * the design issues are a recommended refactor, a method that does not do what it claims, one a caller cannot learn the contract of
 * from its comment, and `complex`, from the metrics alone. `perch fix` works all of them: a defect with the fix agent, the rest by
 * bringing the file's score down.
 */
export function issuesOf(answers, min = 0.5) {
  const issues = [];
  if (answers.has_bug !== undefined && answers.has_bug >= min && (answers.reachable === undefined || answers.reachable >= min)) issues.push({ type: 'defect', label: spaced(answers.kind?.kind ?? 'defect'), probability: answers.has_bug, text: `${spaced(answers.kind?.kind ?? 'defect')} ${percent(answers.has_bug)}` });
  const refactor = answers.refactor?.refactor;
  const refactorProbability = refactor && refactor !== 'none' ? answers.refactor.probabilities?.[refactor] ?? 0 : 0;
  if (refactor && refactor !== 'none' && refactorProbability >= min) issues.push({ type: 'refactor', label: spaced(refactor), probability: refactorProbability, text: `${spaced(refactor)} ${percent(refactorProbability)}` });
  if (answers.does_what_it_claims !== undefined && 1 - answers.does_what_it_claims >= min) issues.push({ type: 'misaligned', label: 'does not do what it claims', probability: 1 - answers.does_what_it_claims, text: `does not do what it claims ${percent(1 - answers.does_what_it_claims)}` });
  if (answers.misdocumented !== undefined && answers.misdocumented >= min) issues.push({ type: 'misdocumented', label: 'misdocumented', probability: answers.misdocumented, text: `misdocumented ${percent(answers.misdocumented)}` });
  const risk = answers.metrics?.risk_score;
  if (risk !== undefined && risk !== null && risk >= COMPLEX_RISK) issues.push({ type: 'complex', label: 'complex', probability: risk / 100, text: `complex, risk ${Math.round(risk)}` });
  return issues.sort((a, b) => b.probability - a.probability);
}
export const isDesign = issue => issue.type !== 'defect';
/** A hunted method is flagged when it carries a reachable defect at `min`. */
export const flagged = (answers, min = 0.5) => issuesOf(answers, min).some(issue => issue.type === 'defect');
/** A method needs design work when it carries a refactor, alignment, documentation, or complexity issue at `min`. */
export const needsDesign = (answers, min = 0.5) => issuesOf(answers, min).some(isDesign);
export const hasIssue = (answers, min = 0.5) => issuesOf(answers, min).length > 0;

export const MAX_CALLEES = 8, MAX_CALLERS = 8, STATE_BUDGET = 48 * 1024, MODULE_SCOPE_BUDGET = 6 * 1024;
/** A Choice accepts at most 255 options; past that, pick a window then the line inside it. */
export const MAX_CHOICES = 255;
const lineId = line => `L${String(line).padStart(4, '0')}`;
const windowId = index => `W${String(index + 1).padStart(4, '0')}`;
const addUsage = (a, b) => !b ? a : { input_tokens: (a?.input_tokens ?? 0) + (b.input_tokens ?? 0), output_tokens: (a?.output_tokens ?? 0) + (b.output_tokens ?? 0) };

/** Code line ids in a method range; blank and comment-only lines are omitted. */
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

/** Ask hunt questions; when the method is longer than MAX_CHOICES, a second Choice ranks the lines in the chosen window. */
export async function locateWhere({ systemOne, state, questions, windows }) {
  const first = await systemOne.ask(state, questions);
  if (!windows) return first;
  const index = Math.max(0, Number(String(first.answers.where_window?.choice ?? windowId(0)).slice(1)) - 1);
  const second = await systemOne.ask(state, { where: whereQuestion(windows[index] ?? windows[0]) });
  return { ...first, answers: { ...first.answers, ...second.answers }, usage: addUsage(first.usage, second.usage) };
}
const tagged = (lines, start) => lines.map((text, index) => `${lineId(start + index)}| ${text}`).join('\n');
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
/** The comment block immediately above a method, if any. */
export function leadingComment(lines, line) {
  const block = [];
  for (let index = line - 2; index >= 0 && (commentLine.test(lines[index]) || (block.length && !lines[index].trim())); index--) block.unshift(lines[index]);
  return block.join('\n').trim();
}

/**
 * The file's top-level code outside every method: constants, regexes, types, module state. What a method's identifiers mean when they
 * are not callees or imports. Blank and comment-only lines are dropped; the result is cut at `budget` bytes.
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
export function huntStep({ node, lines, imports = [], methods = [node], callees, callers, edges = [] }) {
  const build = limit => ({
    method: { path: node.path, name: node.qualified_name, leading_comment: leadingComment(lines, node.line) || null, metrics: node.metrics ?? null, source: tagged(lines.slice(node.line - 1, node.end_line), node.line) },
    imports: imports.map(item => `${item.name}${item.alias !== item.name ? ` as ${item.alias}` : ''} from ${item.module}`),
    module_scope: moduleScope(lines, methods),
    calls: callees.slice(0, MAX_CALLEES).map(({ node: callee, lines: calleeLines, calls = [] }) =>
      ({ id: callee.id, name: callee.qualified_name, path: callee.path, source: excerpt(calleeLines, callee.line, callee.end_line, limit), calls: calls.map(short) })),
    called_by: callers.slice(0, MAX_CALLERS).map(({ node: caller, lines: callerLines, site }) =>
      ({ id: caller.id, name: caller.qualified_name, path: caller.path, calls_method_at: site ?? null, source: excerpt(callerLines, caller.line, caller.end_line, limit, site ?? null) })),
    call_graph: edges,
  });
  let state = build(80);
  for (const limit of [40, 20, 8, 3]) { if (JSON.stringify(state).length <= STATE_BUDGET) break; state = build(limit); }
  const { calls, called_by: calledBy } = state;
  const neighbors = [...calls, ...calledBy].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
  const lineIds = codeLineIds(lines, node.line, node.end_line);
  const windows = lineWindows(lineIds);
  const questions = {
    has_bug: { type: 'noul', instructions: 'Does `method` contain a concrete behavioral defect that a caller can reach?',
      criteria: { true: 'For some input a caller can pass, the method returns a wrong result, leaves wrong state, throws when it should not, or fails to throw when it should', false: 'The method behaves correctly for every input its callers can pass; style, performance, and hypothetical misuse do not count' } },
    ...(windows ? { where_window: whereWindowQuestion(windows) } : { where: whereQuestion(lineIds) }),
    severity: { type: 'score', instructions: 'If `method` has a defect, how severe is it for its callers?', criteria: SEVERITY_LEVELS },
    follow: { type: 'choice', instructions: 'Which related method most likely holds or reveals a defect connected to `method`, and is worth examining next?',
      criteria: { ...Object.fromEntries(neighbors.map(item => [item.id, `${item.name} in ${item.path}`])), none: 'No related method is worth following' } },
  };
  Object.assign(questions, {
    does_what_it_claims: { type: 'noul', instructions: 'Does `method` do what its name, parameters, and `leading_comment` claim it does?',
      criteria: { true: 'Its behavior matches what a reader would expect from its name and comment', false: 'It does something different from, less than, or more than its name and comment promise' } },
    misdocumented: { type: 'noul', instructions: 'Is `method` undocumented or misdocumented for what it does, given its `leading_comment` and its callers?',
      criteria: { true: 'A caller could not learn its contract, edge cases, or side effects from the comment, or the comment is wrong', false: 'The comment, or the code itself for a trivial method, states the contract accurately' } },
    refactor: { type: 'choice', instructions: 'Judging from `method`, its `metrics` (risk_score and maintainability_index run 0-100, cyclomatic_complexity and max_nesting are counts), and how its callers use it, what does it most need?', criteria: REFACTORS },
  });
  for (const [kind, description] of Object.entries(DEFECT_KINDS))
    questions[`kind_${kind}`] = { type: 'noul', instructions: `Does \`method\` have this kind of defect: ${description.toLowerCase()}?`, criteria: { true: `Yes: ${description.toLowerCase()}, reachable by a caller`, false: 'No defect of this kind' } };
  for (const [index, call] of calls.entries())
    questions[`misuse_${index}`] = { type: 'noul', instructions: { callee: call.id, question: 'Does `method` call `callee` in a way that violates the contract evident from the callee\'s source: wrong argument order, type, or shape, an unchecked result, or an ignored error?' },
      criteria: { true: 'At least one call from method to callee breaks what the callee visibly expects or returns', false: 'Every call matches what the callee expects and handles what it returns' } };
  for (const [index, caller] of calledBy.entries())
    questions[`misused_by_${index}`] = { type: 'noul', instructions: { caller: caller.id, question: 'Does `caller` call `method` in a way that violates the contract evident from the method\'s source, or rely on behavior the method does not guarantee?' },
      criteria: { true: 'The caller passes something the method does not handle, or depends on a result or side effect the method does not reliably provide', false: 'The caller uses the method as its source intends' } };
  return { state, questions, calls, calledBy, neighbors, windows };
}

/** Typed answers reduced to the fields the walk and the log use. */
export function readAnswers(answers, { calls, calledBy, neighbors }) {
  const follow = answers.follow.choice;
  const severity = answers.severity.score;
  const kinds = Object.fromEntries(Object.keys(DEFECT_KINDS).map(kind => [kind, answers[`kind_${kind}`].noul]));
  const [topKind, topProbability] = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0];
  return {
    has_bug: answers.has_bug.noul,
    where: { line: Number(answers.where.choice.slice(1)), confidence: answers.where.confidence },
    kind: { kind: topKind, probability: topProbability },
    kinds,
    severity: { score: severity, level: SEVERITY_NAMES[Math.min(SEVERITY_NAMES.length - 1, Math.max(0, Math.round(severity)))], confidence: answers.severity.confidence },
    misuse: calls.map((call, index) => ({ callee: call.id, probability: answers[`misuse_${index}`].noul })),
    misused_by: calledBy.map((caller, index) => ({ caller: caller.id, probability: answers[`misused_by_${index}`].noul })),
    follow: { method: neighbors.some(item => item.id === follow) ? follow : null, confidence: answers.follow.confidence, probabilities: answers.follow.probabilities },
    does_what_it_claims: answers.does_what_it_claims.noul,
    misdocumented: answers.misdocumented.noul,
    refactor: { refactor: answers.refactor.choice, confidence: answers.refactor.confidence, probabilities: answers.refactor.probabilities },
  };
}

const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });

/** The flagged defect as a state entry: kind, the line id used in `method.source`, and the code on it. */
const defectOf = finding => ({ kind: finding.kind.kind, description: DEFECT_KINDS[finding.kind.kind] ?? '', line: lineId(finding.where.line), code: finding.where.text ?? '', method: finding.name, path: finding.path });

/**
 * After `where` is known: can a caller actually execute that line and hit this defect, given the method's own guards?
 * Asked over the hunt's full state (method, imports, callees, callers with call sites), on every hunt that looks defective and again
 * before a generative call is spent.
 */
export function reachCheck({ finding, state }) {
  return {
    state: { defect: defectOf(finding), ...state },
    questions: {
      reachable: noul(
        'Look at `method.source` at `defect.line` and at how `called_by` calls it. Can a real caller produce input or state that actually executes that line and triggers this defect, given the type checks, guards, and early returns already in `method`?',
        'Yes: some input a shown caller can pass, or external input it forwards, reaches that line and hits the defect; no earlier check excludes it',
        'No: an earlier check, type, or branch makes that line or defect unreachable, or no shown caller could pass such input; the method already handles this case',
      ),
    },
  };
}

/**
 * A proof rests on answers the model is sure of. Something that must hold needs at least SURE; something that must not hold may reach at
 * most UNSURE. An answer in between is a shrug, and a shrug never counts as proof.
 */
export const SURE = 0.6, UNSURE = 0.4;

/** The hunt's defect questions again over a patched method, with the original beside it. */
export function patchCheck({ step, original, summary }) {
  const questions = { ...step.questions };
  delete questions.where; delete questions.where_window; delete questions.follow; delete questions.refactor; delete questions.does_what_it_claims; delete questions.misdocumented;
  for (const key of Object.keys(questions)) if (key.startsWith('misuse_')) delete questions[key];
  return { state: { ...step.state, original_method: original, fix_summary: summary }, questions };
}

/**
 * What the patch-check answers say about the patched method, and why they would reject it: the defect probability and the flagged
 * kind must be lower than the hunt found them, and no caller may be newly misused.
 */
export function readPatchCheck({ finding, answers, calledBy }) {
  const kind = answers[`kind_${finding.kind.kind}`]?.noul ?? null;
  const kindBefore = finding.kind.probability ?? null;
  const misusedBy = calledBy.map((caller, index) => ({ caller: caller.id, before: finding.misused_by?.find(item => item.caller === caller.id)?.probability ?? 0, after: answers[`misused_by_${index}`].noul }));
  const verification = { has_bug: answers.has_bug.noul, kind, severity: answers.severity?.score ?? null, misused_by: misusedBy };
  const objections = [
    verification.has_bug >= finding.has_bug && `defect no less likely (${percent(finding.has_bug)} -> ${percent(verification.has_bug)})`,
    kind !== null && kindBefore !== null && kind >= kindBefore && `${label(finding.kind.kind)} looks no less likely (${percent(kindBefore)} -> ${percent(kind)})`,
    ...misusedBy.filter(item => item.after >= SURE && item.before < SURE).map(item => `${item.caller.split('::').at(-1)} would now call it wrong (${percent(item.after)})`),
  ].filter(Boolean);
  return { verification, objections };
}
