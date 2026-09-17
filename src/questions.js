/** The questions one hunt step asks about a method, the state they are asked over, and how the answers are read. */

/** The rubric severity is scored on, weakest first. The bands run the other way, so P0 is the worst. */
export const SEVERITY_LEVELS = [
  'No caller would notice',
  'A wrong result in a rare case, or one the caller can see and recover from',
  'A wrong result or wrong state in ordinary use',
  'Data lost, corrupted, or exposed, or a check that should stop someone bypassed',
];
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
/** What a row prints: the band, and where the score actually landed inside it, so two rows compare without reading their distributions. */
export const severityName = severity => { const score = severityOf(severity); return !score ? '-' : score.predicted === null ? score.band : `${score.band} (${score.predicted.toFixed(1)})`; };
/** The band a method files under, which is what `--filter severity=` reads. */
export const severityBand = severity => severityOf(severity)?.band ?? '-';

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

/**
 * Vulnerability classes, asked of a method the model says touches something outside the program. They are separate from
 * DEFECT_KINDS because a vulnerability is not a wrong answer to a caller: the code does what it was written to do, and that is the problem.
 * Every class is asked of every language rather than chosen by one, since a repository mixes them and a memory-safety question
 * answered about JavaScript costs an answer nobody reads, while a missing one costs a bug nobody finds.
 */
export const SECURITY_KINDS = {
  injection: 'A value from outside is put into a shell command, a query, a path of execution, or anything that gets evaluated, without being escaped or parameterised',
  path_traversal: 'A name from outside is used to build a filesystem path, URL, or key without being confined to the place it is meant to reach',
  unsafe_deserialization: 'Data from outside is parsed, evaluated, or turned into objects in a way that lets it decide what code or type comes back',
  secret_exposure: 'A password, token, key, or other credential is written into the source, logged, returned to a caller, or sent somewhere it need not go',
  missing_authorization: 'An action that should check who is asking, or what they may touch, does not check, or checks after it has already acted',
  weak_crypto: 'Security rests on predictable randomness, a home-made scheme, a broken algorithm, or a comparison that leaks timing',
  unvalidated_destination: 'An address, host, or redirect target from outside decides where a request or a user is sent',
  resource_exhaustion: 'Input from outside decides how much memory, recursion, time, or work happens, with nothing bounding it',
  unsafe_reflection: 'A name from outside chooses which function, class, field, or module is reached, so the caller picks the code that runs',
  disabled_safeguard: 'A check that exists is turned off or weakened: certificate verification skipped, a permission widened, a warning suppressed, a sandbox opened',
  buffer_overflow: 'An index, length, or offset can reach past the end of a buffer, string, slice, or array, on a read or a write',
  use_after_free: 'Something freed, closed, moved, unlocked, or otherwise finished with is used again, or released twice',
  uninitialized_use: 'A value is read on a path where nothing has written it yet, so what a caller gets is whatever was there',
  integer_overflow: 'Arithmetic can wrap, truncate, or change sign, and the result is then used as a size, an index, a length, or a permission',
  race_condition: 'Two paths can reach the same state at once without holding anything, or a check and the act it guards are separated in a way another path can exploit',
  type_confusion: 'A value is treated as a type, shape, or variant it may not be: an unchecked cast, a union read through the wrong member, a parsed object trusted to have a shape',
};

/**
 * The classes that only matter when something from outside reaches the method. The rest are wrong on their own terms: a value
 * freed twice or an index past the end of a buffer is a hole whoever the caller is, and gating those on exposure hid a
 * use-after-free the model had rated at 95% behind a method it was only 46% sure took outside input.
 */
export const EXPOSURE_GATED = new Set(['injection', 'path_traversal', 'unsafe_deserialization', 'secret_exposure', 'missing_authorization', 'unvalidated_destination', 'resource_exhaustion', 'unsafe_reflection']);

/** The strongest vulnerability the answers support. A class that needs outside input is only as likely as that: the two multiply. */
export function securityOf(answers) {
  const exposed = answers.exposed ?? 1;
  const entries = Object.entries(answers.securities ?? (answers.security ? { [answers.security.kind]: answers.security.probability } : {}));
  const joint = entries.map(([kind, probability]) => [kind, EXPOSURE_GATED.has(kind) ? probability * exposed : probability]).sort((a, b) => b[1] - a[1])[0];
  return joint && joint[1] > 0 ? { kind: joint[0], probability: joint[1] } : null;
}

export const REFACTORS = {
  split: 'Does too many things; split it into smaller methods with one job each',
  flatten: 'Nested too deeply; flatten with early returns or extracted helpers',
  simplify_conditions: 'Conditions are hard to follow; simplify or name them',
  deduplicate: 'Repeats logic that exists elsewhere in the shown code; reuse it',
  rename: 'The name or parameters misdescribe what it does; rename them',
  remove_dead_code: 'Contains unreachable or unused code; remove it',
  none: 'No refactor needed',
};


/**
 * Plain names for the defect kinds and refactors. A label is written the way `--filter` takes it, underscores and all, so what a
 * row shows is what you can type back at the command: `too_big 78%` is filtered with `--filter kind=too_big`.
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
export function issuesOf(answers, min = BELIEVED) {
  const issues = [];
  const add = (type, label, probability) => { if (probability > min) issues.push({ type, label, probability, text: `${label} ${percent(probability)}` }); };
  // The chance of a defect is has_bug; the kind is the label the choice puts most weight on, not a second hurdle to clear.
  if (answers.has_bug !== undefined) add('defect', label(answers.kind?.kind ?? 'defect'), answers.has_bug);
  const vulnerability = securityOf(answers);
  if (vulnerability) add('security', label(vulnerability.kind), vulnerability.probability);
  const refactor = answers.refactor?.refactor;
  if (refactor && refactor !== 'none') add('refactor', label(refactor), answers.refactor.probabilities?.[refactor] ?? 0);
  if (answers.does_what_it_claims !== undefined) add('misaligned', 'does_not_do_what_it_claims', 1 - answers.does_what_it_claims);
  if (answers.misdocumented !== undefined) add('misdocumented', 'misdocumented', answers.misdocumented);
  return issues.sort((a, b) => b.probability - a.probability);
}

/**
 * The expected number of problems a reading describes, correctness and design counted apart. Every answer contributes its own
 * probability, so two at 50% weigh what one at 100% weighs and nothing has to cross a line to count.
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
 * Bumped whenever the question set changes. A finding answered by an older set is read again before it is worked: its answers
 * cannot contain a kind that did not exist yet, so every rewrite would look like it introduced one.
 */
export const ANSWERS_VERSION = 3;

/** Everything `--filter` understands, so `perch findings --types` can print it and a typo can be answered with the real list. */
export const filterKeys = () => ({
  type: ['defect', 'security', 'refactor', 'misdocumented', 'misaligned'],
  // The labels a finding is listed under, exactly as a row prints them. parseFilters reads either form, so `kind=too_big` and
  // `kind=too big` both work.
  kind: [...Object.keys(DEFECT_KINDS), ...Object.keys(SECURITY_KINDS), ...Object.keys(REFACTORS).filter(kind => kind !== 'none'), 'misdocumented', 'does_not_do_what_it_claims'].map(label),
  severity: [...SEVERITY_BANDS],
});

const canon = value => String(value).trim().toLowerCase().replace(/[_-]+/g, ' ');
/** How much of the score's mass sits in the band the method files under: how sure the filter's answer is. */
const bandWeight = severity => severity?.probabilities?.[SEVERITY_BANDS.indexOf(severityBand(severity))] ?? 1;

/** `type=security,kind=too big` as a list of tests; an unknown key or value is an error naming what is allowed. */
export function parseFilters(text) {
  const keys = filterKeys(), filters = [];
  for (const clause of String(text).split(',').map(part => part.trim()).filter(Boolean)) {
    const [key, ...rest] = clause.split('=');
    const name = canon(key), value = canon(rest.join('='));
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
/** A hunted method is flagged when it carries a reachable defect at `min`. */
export const flagged = (answers, min = 0) => issuesOf(answers, min).some(issue => !isDesign(issue));
/** A method needs design work when it carries a refactor, alignment, documentation, or complexity issue at `min`. */
export const needsDesign = (answers, min = 0) => issuesOf(answers, min).some(isDesign);
export const hasIssue = (answers, min = 0) => issuesOf(answers, min).length > 0;

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
    called_by: callers.slice(0, MAX_CALLERS).map(({ node: caller, lines: callerLines, site, handover = false }) =>
      ({ id: caller.id, name: caller.qualified_name, path: caller.path,
        ...(handover
          ? { hands_method_on_at: site ?? null, note: 'this caller does not call the method here: it passes it on to be called later, so the call itself is not in view' }
          : { calls_method_at: site ?? null }),
        source: excerpt(callerLines, caller.line, caller.end_line, limit, site ?? null) })),
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
    severity: { type: 'score', instructions: 'If `method` has a defect, how much would a caller feel it?', criteria: SEVERITY_LEVELS },
    kind: { type: 'choice', instructions: 'If `method` has a defect, which kind is it?', criteria: DEFECT_KINDS },
    follow: { type: 'choice', instructions: 'Which related method most likely holds or reveals a defect connected to `method`, and is worth examining next?',
      criteria: { ...Object.fromEntries(neighbors.map(item => [item.id, `${item.name} in ${item.path}`])), none: 'No related method is worth following' } },
  };
  Object.assign(questions, {
    does_what_it_claims: { type: 'noul', instructions: 'Does `method` do what its name, parameters, and `leading_comment` claim it does?',
      criteria: { true: 'Its behavior matches what a reader would expect from its name and comment', false: 'It does something different from, less than, or more than its name and comment promise' } },
    misdocumented: { type: 'noul', instructions: 'Is `method` undocumented or misdocumented for what it does, given its `leading_comment` and its callers?',
      criteria: { true: 'A caller could not learn its contract, edge cases, or side effects from the comment, or the comment is wrong', false: 'The comment, or the code itself for a trivial method, states the contract accurately' } },
    exposed: { type: 'noul', instructions: 'Does `method` handle anything that comes from outside the program, or act on the world outside it?',
      criteria: { true: 'It takes or passes on a request, a file, an environment variable, a database row, a command line, a message, or a response from another service; or it runs a command, builds a query, touches the filesystem, sends a request, or decides what someone is allowed to do',
        false: 'Everything it works on comes from inside the program, and it changes nothing outside it' } },
    refactor: { type: 'choice', instructions: 'Judging from `method`, its `metrics` (risk_score and maintainability_index run 0-100, cyclomatic_complexity and max_nesting are counts), and how its callers use it, what does it most need?', criteria: REFACTORS },
  });
  for (const [kind, description] of Object.entries(SECURITY_KINDS))
    questions[`security_${kind}`] = { type: 'noul', instructions: `If \`method\` handles anything from outside the program: is this true of it? ${description}.`,
      criteria: { true: `Yes: ${description.toLowerCase()}`, false: 'No, or nothing from outside reaches this method' } };
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
  const kinds = answers.kind.probabilities ?? { [answers.kind.choice]: 1 };
  const [topKind, topProbability] = [answers.kind.choice, kinds[answers.kind.choice] ?? 1];
  const securityKinds = Object.fromEntries(Object.keys(SECURITY_KINDS).map(kind => [kind, answers[`security_${kind}`].noul]));
  const [topSecurity, topSecurityProbability] = Object.entries(securityKinds).sort((a, b) => b[1] - a[1])[0];
  return {
    answers_version: ANSWERS_VERSION,
    has_bug: answers.has_bug.noul,
    where: { line: Number(answers.where.choice.slice(1)), confidence: answers.where.confidence },
    kind: { kind: topKind, probability: topProbability },
    kinds,
    severity: { probabilities: answers.severity.probabilities, score: answers.severity.score, confidence: answers.severity.confidence, level: severityOf(answers.severity)?.band ?? null, predicted: severityOf(answers.severity)?.predicted ?? null },
    exposed: answers.exposed.noul,
    security: { kind: topSecurity, probability: topSecurityProbability },
    securities: securityKinds,
    misuse: calls.map((call, index) => ({ callee: call.id, probability: answers[`misuse_${index}`].noul })),
    misused_by: calledBy.map((caller, index) => ({ caller: caller.id, probability: answers[`misused_by_${index}`].noul })),
    follow: { method: neighbors.some(item => item.id === follow) ? follow : null, confidence: answers.follow.confidence, probabilities: answers.follow.probabilities },
    does_what_it_claims: answers.does_what_it_claims.noul,
    misdocumented: answers.misdocumented.noul,
    refactor: { refactor: answers.refactor.choice, confidence: answers.refactor.confidence, probabilities: answers.refactor.probabilities },
  };
}


