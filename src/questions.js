/** The state one method is asked over, the questions perch adds to whatever the question set declares, and how answers are read. */
import { compile, floorFor, issues, questionSet, readAnswer, setHash, vocabulary } from './ask.js';
import { RULES_FILE } from './units.js';
import { sourceChunks } from './chunks.js';
import { TOKEN_LIMITS, estimateTokens, questionBatches, IncompleteCheckError, ContextLimitError } from './tokens.js';

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
    .map(question => [shownAs(question), answers[question.name] * (question.when ? answers[question.when] ?? 1 : 1)]));

/** The name a question's issue prints under: its own label, such as `sql_injection` for `cwe_89`, or its name when it has none. */
const shownAs = question => (question.issue.label && question.issue.label !== 'self' ? question.issue.label : label(question.name));

/**
 * How a class is displayed, where that differs from the name it is declared under in the question set. A label is written the way
 * `--filter` takes it, underscores and all, so what a row shows is what you can type back at the command: `too_big 78%` is
 * filtered with `--filter kind=too_big`.
 */
export const KIND_LABELS = { boundary: 'off_by_one', missing_null_handling: 'unhandled_null', wrong_return: 'wrong_return_value', swallowed_error: 'error_ignored', state_mutation: 'bad_state_change', ordering: 'wrong_order', resource_leak: 'leak', inverted_condition: 'inverted_condition', wrong_lookup: 'wrong_lookup',
  split: 'too_big', flatten: 'too_nested', simplify_conditions: 'tangled_conditions', deduplicate: 'duplicated_logic', rename: 'misnamed', remove_dead_code: 'dead_code', none: 'none' };
export const label = kind => KIND_LABELS[kind] ?? kind;

const percent = value => `${Math.round(value * 100)}%`;
/**
 * The default floor for a run. Each question can set a stricter or looser floor in scan.yaml; the higher of its floor and the
 * run's --min decides whether that answer is printed. --min 0 bypasses question floors and lists everything the scan
 * answered; no answer ever comes back at exactly zero.
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
 * Two numbers rather than one, because whoever ranks on them weighs the sides differently and cannot separate them afterwards.
 * Every answer contributes its own probability, so two at 50% count what one at 100% counts and nothing has to cross a line to
 * be counted at all: a floor here would make the ranking jump as answers crossed it.
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
export const filterKeys = (questions = questionSet(), rules = []) => {
  const { types, labels } = vocabulary(questions, label);
  // `lint` is a type no question in the set declares: a rule raises it, and a rule may be added between a run and a report of it.
  // `rule` names them one at a time, so a rule just written can be run on its own rather than behind every other rule.
  return { type: [...new Set([...types, 'lint'])], kind: labels, severity: [...SEVERITY_BANDS], rule: rules.map(rule => rule.name) };
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
export function parseFilters(text, rules = []) {
  const keys = filterKeys(questionSet(), rules), filters = [];
  // A part with no `=` is another value for the key before it, so `type=defect,security` and `rule=a,b` say two things about one
  // key. Without this the second value read as a key and the documented form was an error.
  let name = null;
  for (const clause of String(text).split(',').map(part => part.trim()).filter(Boolean)) {
    const at = clause.indexOf('=');
    const spelled = at === -1 ? clause : clause.slice(at + 1);
    if (at !== -1) {
      name = canon(clause.slice(0, at));
      if (!Object.hasOwn(keys, name)) throw new Error(`unknown filter "${clause.slice(0, at).trim()}"; filter on ${Object.keys(keys).join(', ')}`);
    }
    if (!name) throw new Error(`filter "${clause}" is written key=value; filter on ${Object.keys(keys).join(', ')}`);
    const value = name === 'type' ? meaning(spelled) : canon(spelled);
    if (!value) throw new Error(`filter ${name} needs a value: one of ${keys[name].join(', ')}`);
    if (!keys[name].length) throw new Error(`${name} takes a name from ${RULES_FILE}, and there are none`);
    const allowed = keys[name].map(canon);
    if (!allowed.includes(value)) throw new Error(`${name} "${spelled.trim()}" is not one of ${keys[name].join(', ')}`);
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
      // `rule` and `kind` both name the label an issue is filed under; a rule's label is its own name.
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
  const named = issue => filters.some(({ key, value }) => (key === 'type' ? issue.type === value
    : key === 'kind' || key === 'rule' ? canon(issue.label) === value : issue.type === 'defect'));
  return [...issues.filter(named), ...issues.filter(issue => !named(issue))];
}

export const isDesign = issue => issue.type !== 'defect' && issue.type !== 'security';
/** Design problems do not count here: a method nobody can break is not flagged for being ugly. */
export const flagged = (answers, min = 0) => issuesOf(answers, min).some(issue => !isDesign(issue));
/** Not the opposite of flagged: a method can be both wrong and badly shaped, and the two are counted and ranked apart. */
export const needsDesign = (answers, min = 0) => issuesOf(answers, min).some(isDesign);
export const hasIssue = (answers, min = 0) => issuesOf(answers, min).length > 0;

export const MAX_CALLEES = 8, MAX_CALLERS = 8, STATE_BUDGET = TOKEN_LIMITS.state;
/**
 * Lines as they are sent: the text and nothing about where in its file it sits. An answer is cached under the state it was asked
 * over, so a line number in the state made every method below an inserted line a state nobody had asked about, and every method
 * showing one of them as a neighbour another. Consecutive null lines, which belong to methods read on their own, are one line
 * saying so.
 */
export const shownLines = lines => lines.flatMap((text, index) => (text !== null ? [text] : lines[index - 1] !== null ? ['... (read on its own)'] : [])).join('\n');
/** Returns a unit's lines from first to last. For a top-level unit, lines that belong to methods are null. */
export const spanOf = (node, lines) => {
  const own = node.lines && new Set(node.lines);
  return lines.slice(node.line - 1, node.end_line).map((text, index) => (!own || own.has(node.line + index) ? text : null));
};
/**
 * A neighbour as it is shown: the comment above it, which is its contract, then its lines, or a window of `limit` lines of the
 * two together. When a `focus` line is given (a call site) the window is centered there so the call is visible.
 */
const excerpt = (node, lines, limit, focus = null) => {
  const comment = leadingComment(lines, node.line), above = comment ? comment.split('\n') : [];
  const slice = [...above, ...spanOf(node, lines)];
  if (slice.length <= limit) return shownLines(slice);
  const from = focus === null ? 0 : Math.min(Math.max(0, above.length + focus - node.line - Math.floor(limit / 2)), slice.length - limit);
  const shown = shownLines(slice.slice(from, from + limit));
  return `${from ? `... (${from} lines above)\n` : ''}${shown}${from + limit < slice.length ? `\n... (${slice.length - from - limit} more lines)` : ''}`;
};
const commentLine = /^\s*(\/\/|\/\*|\*|#|"""|''')/;
/** A method's contract is written above it, not inside it, so any question about documentation has to reach up for it. */
export function leadingComment(lines, line) {
  const block = [];
  for (let index = line - 2; index >= 0 && (commentLine.test(lines[index]) || (block.length && !lines[index].trim())); index--) block.unshift(lines[index]);
  return block.join('\n').trim();
}

/**
 * The text a question about a method or a test is shown of it: the comment above it, then its lines. An answer is about this
 * text, so its hash is what says whether an answer still stands, and a hash of the body alone kept an answer about a comment
 * after the comment was gone.
 */
export function shownSource(lines, line, endLine) {
  const comment = leadingComment(lines, line);
  return (comment ? `${comment}\n` : '') + lines.slice(line - 1, endLine).join('\n');
}

const HANDED_ON = 'does not call the method here: it passes it on to be called later, so the call itself is not in view';

/**
 * The state and questions for one method.
 *
 * The state is the method and its call graph, and nothing else: the method's source under the comment above it and the metrics
 * measured from that source, each caller and callee shown the same way, and the edges between them. So it changes when the
 * method or a neighbour does, and an answer already given about it is still the answer after code elsewhere in the file moves
 * it down a line.
 *
 * `node` is the graph node and `lines` its file's lines. `callees` and `callers` are [{ node, lines, site, handover }] with the
 * neighbor's file lines and, for a caller, the calling line, which is where its excerpt is centered. `edges` are [from, to]
 * pairs of method ids.
 */
export function methodStep({ node, lines, callees, callers, edges = [], budget = STATE_BUDGET, limits = [40, 20, 8, 3], maxCallees = MAX_CALLEES, maxCallers = MAX_CALLERS, chunk = null, asked = questionSet().filter(question => question.each === 'method') }) {
  const id = node.id ?? `${node.path}::${node.qualified_name}`;
  // One pass of a method read in several holds a slice of it, and for a top-level unit the lines of the methods inside it are
  // left out. `span` is the lines this pass is about, null where a line is another unit's, and `start` is the first one's number.
  const span = chunk ? chunk.source.split('\n').map((text, index) => (!node.lines || node.lines.includes(chunk.line + node.line - 1 + index) ? text : null)) : spanOf(node, lines);
  const start = chunk ? chunk.line + node.line - 1 : node.line;
  const source = [leadingComment(lines, node.line), chunk && chunk.line > 1 ? `... (${chunk.line - 1} lines above)` : '', shownLines(span)].filter(Boolean).join('\n');
  const named = ({ node: neighbor }) => ({ id: neighbor.id, name: neighbor.qualified_name, path: neighbor.path });
  const build = (limit, [fewerCallees, fewerCallers] = [maxCallees, maxCallers]) => {
    const calls = callees.slice(0, fewerCallees), calledBy = callers.slice(0, fewerCallers);
    // A method that both calls this one and is called by it is one node, shown as the callee it is.
    const nodes = new Map(calls.map(({ node: callee, lines: calleeLines }) => [callee.id, { id: callee.id, path: callee.path, source: excerpt(callee, calleeLines, limit) }]));
    for (const { node: caller, lines: callerLines, site, handover = false } of calledBy)
      if (!nodes.has(caller.id)) nodes.set(caller.id, { id: caller.id, path: caller.path, source: excerpt(caller, callerLines, limit, site ?? null), ...(handover ? { note: HANDED_ON } : {}) });
    // An edge is drawn from code in view, so the edges go when the neighbourhood does, and one from a method not shown is left
    // out: it would change the state when code nothing here shows changed.
    const drawn = nodes.size ? edges.filter(([from]) => from === id || nodes.has(from)).map(([from, to]) => `${from} -> ${to}`) : [];
    return { state: { method: { path: node.path, name: node.qualified_name, metrics: node.metrics ?? null, source }, graph: { nodes: [...nodes.values()], edges: drawn } }, calls: calls.map(named), calledBy: calledBy.map(named) };
  };
  const over = () => estimateTokens(built.state) > budget;
  let built = build(limits[0] === Infinity ? Infinity : 80);
  for (const limit of limits) { if (!over()) break; built = build(limit); }
  // Fewer neighbours before none, and none before refusing: a method read without its callers is a weaker reading than one
  // read with them, and a method not read at all is no reading. Shortening the excerpts alone left the count at eight each, so
  // a method in a dense graph failed the same way on every retry.
  for (const fewer of [4, 2, 1, 0]) { if (!over()) break; built = build(limits.at(-1), [Math.min(fewer, maxCallees), Math.min(fewer, maxCallers)]); }
  if (over()) throw new ContextLimitError(`${node.path}::${node.qualified_name}: method context exceeds the token budget`, budget / 2);
  const { state, calls, calledBy } = built;
  if (chunk?.partial) state.reading = { start_byte: chunk.startByte, end_byte: chunk.endByte, partial: true };
  if (over()) throw new ContextLimitError(`${node.path}: method metadata exceeds the token budget`, budget / 2);
  const neighbors = [...calls, ...calledBy].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
  // The questions themselves are declared, not written here: what perch asks of a method is data, so a repository can reword a
  // class or add one without this function hearing about it. What stays is what is not a question about your code — which
  // method to read next, and how each neighbour uses this one — because both are built from this method's own neighbourhood.
  const questions = {
    ...compile(asked),
    follow: { type: 'choice', instructions: 'Which related method most likely holds or reveals a defect connected to `method`, and is worth examining next?',
      criteria: { ...Object.fromEntries(neighbors.map(item => [item.id, `${item.name} in ${item.path}`])), none: 'No related method is worth following' } },
  };
  for (const [index, call] of calls.entries())
    questions[`misuse_${index}`] = { type: 'noul', instructions: { callee: call.id, question: 'Does `method` call `callee` in a way that violates the contract evident from the callee\'s source: wrong argument order, type, or shape, an unchecked result, or an ignored error?' },
      criteria: { true: 'At least one call from method to callee breaks what the callee visibly expects or returns', false: 'Every call matches what the callee expects and handles what it returns' } };
  for (const [index, caller] of calledBy.entries())
    questions[`misused_by_${index}`] = { type: 'noul', instructions: { caller: caller.id, question: 'Does `caller` call `method` in a way that violates the contract evident from the method\'s source, or rely on behavior the method does not guarantee?' },
      criteria: { true: 'The caller passes something the method does not handle, or depends on a result or side effect the method does not reliably provide', false: 'The caller uses the method as its source intends' } };
  // What this pass read, in the file's own line numbers, which are kept here and never sent.
  const first = span.findIndex(text => text !== null), last = span.findLastIndex(text => text !== null);
  return { state, questions, asked, calls, calledBy, neighbors, covers: { line: first < 0 ? node.line : start + first, end_line: last < 0 ? node.end_line : start + last, ...(chunk ? { start_byte: chunk.startByte, end_byte: chunk.endByte } : {}) } };
}

/** Native syntax chunks overlap in source bytes, including when one line spans multiple requests. */
export function methodSteps({ node, lines, callees = [], callers = [], edges = [], ...options }) {
  // Blank the lines that belong to other methods instead of removing them, so a chunk's line still counts from the unit's first.
  const source = spanOf(node, lines).map(text => text ?? '').join('\n');
  const budget = options.budget ?? STATE_BUDGET;
  let maxTokens = budget;
  for (;;) {
    const chunks = sourceChunks(source, { path: node.path, maxTokens });
    try {
      const steps = chunks.map((chunk, index) => methodStep({ node, lines,
        callees: index ? [] : callees, callers: index ? [] : callers, edges: index ? [] : edges,
        ...options, budget, chunk: { ...chunk, partial: chunks.length > 1 } }));
      for (const step of steps) questionBatches(step.state, step.questions);
      return steps;
    } catch (error) {
      if (!(error instanceof IncompleteCheckError) || maxTokens <= 128) throw error;
      maxTokens = Math.max(128, Math.floor(maxTokens / 2));
    }
  }
}

/**
 * Typed answers reduced to what the walk and the log use. Every declared question is kept under its own name, whatever it is, so
 * a class added to the question set is recorded without this function being told. The rest are the machinery's own answers: which
 * method to read next, and what the neighbours look like from here.
 */
export function readAnswers(answers, { calls, calledBy, neighbors, asked = questionSet().filter(question => question.each === 'method') }) {
  const follow = answers.follow.choice;
  const read = { answers_set: setHash(asked) };
  for (const question of asked) read[question.name] = readAnswer(question, answers[question.name]);
  return {
    ...read,
    severity: { ...read.severity, level: severityOf(read.severity)?.band ?? null, predicted: severityOf(read.severity)?.predicted ?? null },
    misuse: calls.map((call, index) => ({ callee: call.id, probability: answers[`misuse_${index}`].noul })),
    misused_by: calledBy.map((caller, index) => ({ caller: caller.id, probability: answers[`misused_by_${index}`].noul })),
    follow: { method: neighbors.some(item => item.id === follow) ? follow : null, confidence: answers.follow.confidence, probabilities: answers.follow.probabilities },
  };
}
