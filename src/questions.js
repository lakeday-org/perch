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

/** A hunted method is flagged when the model expects a reachable defect at probability `min` or more. */
export const flagged = (answers, min = 0.5) => answers.has_bug >= min;
/** A hunted method needs design work when the model names a refactor, or doubts it does what it claims, at `min` or more. Documentation alone does not qualify. */
export const needsDesign = (answers, min = 0.5) => (answers.refactor && answers.refactor.refactor !== 'none' && (answers.refactor.probabilities?.[answers.refactor.refactor] ?? 0) >= min)
  || (answers.does_what_it_claims !== undefined && 1 - answers.does_what_it_claims >= min);

export const MAX_CALLEES = 8, MAX_CALLERS = 8, STATE_BUDGET = 48 * 1024;
const lineId = line => `L${String(line).padStart(4, '0')}`;
const tagged = (lines, start) => lines.map((text, index) => `${lineId(start + index)}| ${text}`).join('\n');
const excerpt = (lines, start, end, limit) => {
  const slice = lines.slice(start - 1, end);
  return slice.length > limit ? tagged(slice.slice(0, limit), start) + `\n... (${slice.length - limit} more lines)` : tagged(slice, start);
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
 * The state and questions for one method.
 * `node` is the graph node and `lines` its file's lines. `imports` are the file's import records.
 * `callees` and `callers` are [{ node, lines, site, calls }] with the neighbor's file lines, the calling line (callers),
 * and the names of the neighbor's own callees (second hop). `edges` are ["a -> b"] strings for the neighborhood.
 */
export function huntStep({ node, lines, imports = [], callees, callers, edges = [] }) {
  const build = limit => ({
    method: { path: node.path, name: node.qualified_name, leading_comment: leadingComment(lines, node.line) || null, metrics: node.metrics ?? null, source: tagged(lines.slice(node.line - 1, node.end_line), node.line) },
    imports: imports.map(item => `${item.name}${item.alias !== item.name ? ` as ${item.alias}` : ''} from ${item.module}`),
    calls: callees.slice(0, MAX_CALLEES).map(({ node: callee, lines: calleeLines, calls = [] }) =>
      ({ id: callee.id, name: callee.qualified_name, path: callee.path, source: excerpt(calleeLines, callee.line, callee.end_line, limit), calls: calls.map(short) })),
    called_by: callers.slice(0, MAX_CALLERS).map(({ node: caller, lines: callerLines, site }) =>
      ({ id: caller.id, name: caller.qualified_name, path: caller.path, calls_method_at: site ?? null, source: excerpt(callerLines, caller.line, caller.end_line, limit) })),
    call_graph: edges,
  });
  let state = build(80);
  for (const limit of [40, 20, 8, 3]) { if (JSON.stringify(state).length <= STATE_BUDGET) break; state = build(limit); }
  const { calls, called_by: calledBy } = state;
  const neighbors = [...calls, ...calledBy].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
  const lineIds = Object.fromEntries(Array.from({ length: node.end_line - node.line + 1 }, (_, index) => [lineId(node.line + index), null]));
  const questions = {
    has_bug: { type: 'noul', instructions: 'Does `method` contain a concrete behavioral defect that a caller can reach?',
      criteria: { true: 'For some input a caller can pass, the method returns a wrong result, leaves wrong state, throws when it should not, or fails to throw when it should', false: 'The method behaves correctly for every input its callers can pass; style, performance, and hypothetical misuse do not count' } },
    where: { type: 'choice', instructions: 'Which line of `method` is the defect on? If there is no defect, pick the line most likely to hide one.', criteria: lineIds },
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
  return { state, questions, calls, calledBy, neighbors };
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

/** Questions about a proposed regression test, asked before it is run. `callers` are the hunt's `called_by` records, so reachability is judged against real call sites. */
export function testCheck({ finding, method, test, testPath, callers = [] }) {
  const state = { defect: { kind: finding.kind.kind, line: finding.where.line, code: finding.where.text ?? '', method: finding.name, path: finding.path }, original_method: method, called_by: callers, test: { path: testPath, source: test } };
  const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
  return { state, questions: {
    imports_real_method: noul('Does `test` import and call the real method from its module in the repository, rather than a copy or a stub?', 'It imports the module at `defect.path` and calls the method', 'It defines its own copy, mocks the method, or never calls it'),
    targets_defect: noul('Does `test` exercise the input or state that triggers the described defect?', 'Its inputs reach the defective line and the assertion checks the behavior that is wrong', 'It tests something else, or would not reach the defect'),
    reachable_by_callers: noul('Could the input or state `test` gives the method arise from its real callers in `called_by` (or from outside the program, if it is an entry point), rather than being a value no caller could ever pass?',
      'A caller shown, or external input it forwards, can produce this input or state in practice', 'No caller could pass this; the test constructs a value or state the method never receives, such as a type its callers never produce'),
    asserts_behavior: noul('Does `test` assert on observable behavior rather than on implementation details or on the test\'s own values?', 'It asserts a return value, thrown error, or resulting state that callers can observe', 'It asserts on internals, on constants it defined itself, or on nothing'),
    passes_on_original: noul('Would `test` pass against `original_method` as written, with the defect still present?', 'The assertion holds on the original, so the test does not demonstrate the defect', 'The assertion fails on the original because of the defect'),
  } };
}

/**
 * A proof rests on answers the model is sure of. Something that must hold needs at least SURE; something that must not hold may reach at
 * most UNSURE. An answer in between is a shrug, and a shrug never counts as proof.
 */
export const SURE = 0.6, UNSURE = 0.4;
const percent = value => `${Math.round(value * 100)}%`;

/** Whether the model believes a regression test is sound. */
export const soundTest = answers => testObjections(answers) === '';
export const testObjections = answers => [
  answers.imports_real_method.noul < SURE && `the test does not clearly import and call the real method (${percent(answers.imports_real_method.noul)})`,
  answers.targets_defect.noul < SURE && `the test does not clearly exercise the described defect (${percent(answers.targets_defect.noul)})`,
  answers.reachable_by_callers.noul < SURE && `it is not clear any real caller could pass the input the test constructs (${percent(answers.reachable_by_callers.noul)}), so it does not demonstrate a reachable defect`,
  answers.asserts_behavior.noul < SURE && `the test does not clearly assert on observable behavior (${percent(answers.asserts_behavior.noul)})`,
  answers.passes_on_original.noul > UNSURE && `the test may pass on the original (${percent(answers.passes_on_original.noul)}), so it does not clearly demonstrate the defect`,
].filter(Boolean).join('; ');

/** The hunt's questions again over a patched method, plus one about collateral change. */
export function patchCheck({ step, original, summary }) {
  const questions = { ...step.questions };
  delete questions.where; delete questions.follow; delete questions.refactor; delete questions.does_what_it_claims; delete questions.misdocumented;
  for (const key of Object.keys(questions)) if (key.startsWith('misuse_')) delete questions[key];
  questions.collateral_change = { type: 'noul', instructions: 'Comparing `original_method` with `method`, does the change alter any behavior other than fixing the described defect (`fix_summary`)?',
    criteria: { true: 'Some input that was handled correctly before now behaves differently', false: 'Only the defective behavior changed' } };
  return { state: { ...step.state, original_method: original, fix_summary: summary }, questions };
}

/** What the patch-check answers say about the patched method, and why they would reject it. The defect must be clearly gone, not merely doubted. */
export function readPatchCheck({ finding, answers, calledBy }) {
  const kind = answers[`kind_${finding.kind.kind}`]?.noul ?? null;
  const misusedBy = calledBy.map((caller, index) => ({ caller: caller.id, before: finding.misused_by?.find(item => item.caller === caller.id)?.probability ?? 0, after: answers[`misused_by_${index}`].noul }));
  const verification = { has_bug: answers.has_bug.noul, kind, severity: answers.severity?.score ?? null, collateral_change: answers.collateral_change.noul, misused_by: misusedBy };
  const objections = [
    verification.has_bug > UNSURE && `the patched method still looks defective (${percent(verification.has_bug)})`,
    kind !== null && kind > UNSURE && `the ${finding.kind.kind.replaceAll('_', ' ')} defect still looks present (${percent(kind)})`,
    verification.collateral_change > UNSURE && `the patch may change behavior beyond the defect (${percent(verification.collateral_change)})`,
    ...misusedBy.filter(item => item.after >= SURE && item.before < SURE).map(item => `${item.caller.split('::').at(-1)} now misuses the patched method (${percent(item.after)})`),
  ].filter(Boolean);
  return { verification, objections };
}
