/**
 * The question grammar. Every question perch puts to System One — the ones it ships with and the rules you write — is a record in
 * a YAML file with the same seven-odd keys, and this module reads them, checks them, turns them into typed questions, and reads
 * the answers back as issues.
 *
 * It exists because the alternative was two vocabularies for one idea. A scan's questions lived in code as four constant maps and
 * a hand-written `issuesOf` that knew each one by name, so adding a vulnerability class meant editing three files and bumping a
 * version number, and a rule you wrote could never be anything but a yes-or-no. Here a question declares what it asks and what
 * the answer means, and nothing downstream has to have heard of it.
 *
 * What is deliberately not expressible: which line a defect is on, which method to read next, and how much neighbourhood fits in
 * a request. Those are not questions about your code, they are how perch works, and they stay in src/questions.js.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

/** A noul is a probability, a choice a distribution over named options, a score a distribution over a rubric's levels. */
export const SHAPES = ['noul', 'choice', 'score'];
/** What one question is asked of: a whole file, a method in one, or a single test block. */
export const EACH = ['file', 'method', 'test'];
/**
 * What a file or a test is shown besides itself. A method needs no such key: it is always asked with its callers and callees in
 * view, because that is the context a scan builds for it and every question about it is asked over that one context.
 */
export const SEES = ['self', 'file', 'calls', 'callers', 'neighbors'];
/**
 * `ensure` is asked of every unit and every unit has to satisfy it. The other two are asked of units in turn until one answers,
 * because the claim is about the codebase and not about any one file: `ensure_present` passes at the first unit that has the
 * thing, `ensure_absent` fails at the first unit that has it. Passing a present rule is cheap and proving an absent rule is not,
 * which is the right way round — proving an absence is the expensive claim.
 */
export const ENSURES = ['ensure', 'ensure_present', 'ensure_absent'];
export const SEARCHES = kind => kind === 'ensure_present' || kind === 'ensure_absent';

const KEYS = new Set(['name', 'disabled', 'min', 'gate', 'type', 'each', 'where', 'except', 'sees', 'ask', 'true', 'false', 'options', 'levels', 'when', 'issue', ...ENSURES]);
const ISSUE_KEYS = new Set(['type', 'label', 'on', 'pick', 'except']);
/** A correctness issue is weighed by the severity rubric; everything else weighs as itself. */
export const CORRECTNESS = new Set(['defect', 'security']);

/**
 * A rule you write is a noul that raises an issue when the answer is no. Written out it would be six lines saying the same thing
 * every rule says, so `ensure:` says it instead. The question text is both the instruction and the true criterion, because the
 * rule's own wording is the only description of the rule there is.
 */
function expand(rule) {
  const kind = ENSURES.find(key => rule[key]);
  if (!kind) return rule;
  const text = String(rule[kind]).replace(/\s+/g, ' ').trim();
  const searching = SEARCHES(kind);
  return {
    ...rule, kind, text,
    type: 'noul',
    ask: searching
      ? 'Is `looking_for` here, in the code below? Answer about this code alone; somewhere else having it is not this.'
      : 'Is `rule` true of the code below?',
    true: text,
    false: searching ? `Not here: ${text}` : `Not so: ${text}`,
    // A present rule is broken by finding nothing anywhere, which no single unit's answer decides, so the search reads the
    // answers itself. An absent rule and a plain ensure are broken by one unit, and say so the ordinary way. A rule that
    // declares its own issue keeps it: the shorthand is for the wording, not a ceiling on what the answer may mean.
    issue: rule.issue ?? (kind === 'ensure_present' ? null : { type: 'lint', label: 'self', on: kind !== 'ensure_absent' ? false : true }),
  };
}

/**
 * Whether a finding from this question fails the scan.
 *
 * Something wrong does: a defect, a vulnerability, a rule saying your code holds a property. Something large or undocumented
 * does not, since neither is wrong. `gate: false` says a question is worth reading and not worth failing over, which is where a
 * judgement call belongs.
 */
const GATED = new Set(['defect', 'security', 'lint']);
// A search rule declares no issue of its own, so reading the type alone left every ensure_present and ensure_absent rule
// ungated: broken at 100% and the run still passed. A rule is a rule whichever shape it is written in.
const gates = question => (question.gate === undefined ? GATED.has(question.issue?.type) || SEARCHES(question.kind) : question.gate);

/** A question that cannot be understood is a mistake to fix now, not a question to skip quietly at the point it would have mattered. */
export function check(question, at, noun = 'question') {
  if (!question?.name) throw new Error(`${at}: every ${noun} needs a name`);
  const where = `${question.name} (${at})`;
  const extra = Object.keys(question).filter(key => !KEYS.has(key));
  if (extra.length) throw new Error(`${where}: ${extra.join(', ')} is not a key; the keys are ${[...KEYS].join(', ')}`);
  // A question turned off needs to say which one and nothing else. Making it restate a selector and a criteria pair to say it is
  // not being asked would be asking for the thing that is not wanted.
  if (question.disabled) return { name: question.name, disabled: true, declared: question, at, type: null, kind: null, text: null, hash: 'off' };
  const full = expand(question);
  const type = full.type ?? 'noul';
  if (!SHAPES.includes(type)) throw new Error(`${where}: type is ${SHAPES.join(', ')}, not ${type}`);
  if (!full.where) throw new Error(`${where}: needs where to say what it applies to`);
  if (full.each && !EACH.includes(full.each)) throw new Error(`${where}: each is ${EACH.join(', ')}, not ${full.each}`);
  // A rule covers whole files unless it says otherwise, since a rule about prose is a rule about a file. A question perch ships
  // is about a method, because that is what a scan reads.
  const each = full.each ?? (full.kind ? 'file' : 'method');
  if (full.sees && !SEES.includes(full.sees)) throw new Error(`${where}: sees is ${SEES.join(', ')}, not ${full.sees}`);
  // Silently ignoring it would let a rule read as though it had asked for something it never got.
  if (full.sees && each === 'method') throw new Error(`${where}: a method is always asked with its callers and callees in view, so sees says nothing here`);
  if (!full.ask) throw new Error(`${where}: needs ask, or one of ${ENSURES.join(', ')}`);
  if (type === 'noul' && (full.true === undefined || full.false === undefined)) throw new Error(`${where}: a noul needs true and false`);
  if (type === 'choice' && !full.options) throw new Error(`${where}: a choice needs options`);
  if (type === 'score' && !Array.isArray(full.levels)) throw new Error(`${where}: a score needs levels, weakest first`);
  // How sure this one has to be before it is worth saying. A question the model hedges on fills a report with coin flips, and
  // where that line sits is a judgement about the question rather than about the run, so it is set beside the question.
  if (full.min !== undefined && !(Number(full.min) >= 0 && Number(full.min) <= 100)) throw new Error(`${where}: min is a percentage, 0 to 100, not ${full.min}`);
  if (full.gate !== undefined && typeof full.gate !== 'boolean') throw new Error(`${where}: gate is true or false, not ${full.gate}`);
  if (full.issue) {
    const unknown = Object.keys(full.issue).filter(key => !ISSUE_KEYS.has(key));
    if (unknown.length) throw new Error(`${where}: issue takes ${[...ISSUE_KEYS].join(', ')}, not ${unknown.join(', ')}`);
    if (!full.issue.type) throw new Error(`${where}: an issue needs a type`);
  }
  return { ...full, type, each, sees: full.sees ?? 'self', min: full.min === undefined ? null : Number(full.min), gate: gates(full),
    kind: full.kind ?? null, text: full.text ?? null, at,
    // As it was written, so a question perch ships can be copied into your own file and changed from there.
    declared: question,
    hash: sha(JSON.stringify([full.ask, full.true, full.false, full.options, full.levels, full.where, full.except, full.each, full.sees])) };
}

const sha = text => createHash('sha256').update(text).digest('hex');

/** Later files win, so a repository can reword a question perch ships without forking the file it came in. */
export function merge(...sets) {
  const byName = new Map();
  for (const set of sets.flat()) byName.set(set.name, set);
  return [...byName.values()];
}

export function parseQuestions(text, at, noun = 'question') {
  // An empty file has no questions in it. A file with something in it that reads as nothing is a file someone wrote wrong, and
  // answering that with an empty list asks none of their rules and never says so.
  const doc = text.trim() ? parse(text) : [];
  const list = Array.isArray(doc) ? doc : doc?.rules;
  if (!Array.isArray(list)) throw new Error(`${at}: expected a list of ${noun}s, or a map with rules: under it`);
  return list.map((question, index) => check(question, `${at} ${noun} ${index + 1}`, noun));
}

/**
 * Paths a scan does not read at all, as globs. A repository with a fixture in it — code with a bug in every method, kept so the
 * docs can show real output — has nothing to gain from being told about them on every run.
 *
 * Only the map form of the file has one. A bare list is a list of rules and always was.
 */
export function parseIgnored(text, at) {
  const doc = text.trim() ? parse(text) : [];
  if (Array.isArray(doc) || !doc) return [];
  const ignore = doc.ignore ?? [];
  if (!Array.isArray(ignore) || ignore.some(glob => typeof glob !== 'string')) throw new Error(`${at}: ignore is a list of globs`);
  return ignore;
}

/** The questions perch ships with, read once. The file is the source of truth; nothing here is duplicated in code. */
export const BUILTIN = parseQuestions(readFileSync(new URL('../scan.yaml', import.meta.url), 'utf8'), 'scan.yaml');

/**
 * The set in force. Reading a repository's own questions installs them here, so a report built from a finding on disk labels it
 * the way the run that wrote it did, without every function between the two taking a question set it does not otherwise use.
 */
let installed = BUILTIN;
/** The questions in force. One turned off is not one of them, so nothing that asks has to know about being turned off. */
export const questionSet = () => installed.filter(question => !question.disabled);
/** All of them, off ones included, for a listing: what a repository has turned off is part of what it has decided to ask. */
export const allQuestions = () => installed;
export const installQuestions = set => { installed = set; return set; };

/**
 * What identifies the answers: the questions that produced them. A finding answered under a different set is read again rather
 * than trusted, because its answers cannot mention a class that did not exist yet and every added class would look like a find.
 */
export const setHash = (questions = questionSet()) => sha(questions.map(question => `${question.name}:${question.hash}`).sort().join('\n')).slice(0, 16);

/**
 * What was put to the model, as one value. Two requests carrying the same state and asking the same questions must come back the
 * same, so the second need not be sent: this is what "the same" means, and it covers the code, everything around it that went
 * into the request, and the wording of every question, your rules included.
 */
export const askKey = (steps, asked) => sha(JSON.stringify([steps.map(step => step.state), asked.map(question => question.hash).sort()]));

/**
 * How sure this one has to be before it counts. Both floors apply and the higher wins: a question that hedges sets its own, and
 * `--min` sets one for the run, so asking for 90% does not get you back a 73% because some rule said 70 was enough.
 *
 * `--min 0` is the exception, and means what zero says: every answer, floors and all, which is how you see what a question is
 * really doing before deciding where its floor belongs. Everything that decides whether something is broken reads this, so a run
 * cannot report one number and count another.
 */
export const floorFor = (question, min) => (min === 0 ? 0 : Math.max(min, question?.min == null ? 0 : question.min / 100));

/** The questions asked of a method, as System One takes them. Only the shape; the state they are asked over is built elsewhere. */
export function compile(questions) {
  const typed = {};
  for (const question of questions) {
    if (question.type === 'noul') typed[question.name] = { type: 'noul', instructions: question.ask, criteria: { true: question.true, false: question.false } };
    else if (question.type === 'choice') typed[question.name] = { type: 'choice', instructions: question.ask, criteria: { ...question.options } };
    else typed[question.name] = { type: 'score', instructions: question.ask, criteria: [...question.levels] };
  }
  return typed;
}

/**
 * One question's answer, reduced to what is kept. A noul keeps its probability; a choice keeps what it picked, how sure, and the
 * whole distribution, since a label chosen at 34% and one chosen at 94% are not the same finding.
 */
export function readAnswer(question, answer) {
  if (question.type === 'noul') return answer.noul;
  if (question.type === 'choice') return { choice: answer.choice, probability: answer.probabilities?.[answer.choice] ?? 1, probabilities: answer.probabilities ?? { [answer.choice]: 1 } };
  return { probabilities: answer.probabilities, score: answer.score, confidence: answer.confidence };
}

const value = answer => (typeof answer === 'number' ? answer : answer?.probability ?? 0);
/** A question gated on another is only as likely as the gate: the two multiply. */
const gated = (question, answers) => value(answers[question.name]) * (question.when ? value(answers[question.when]) ?? 1 : 1);

/**
 * How an answer is named. `label: self` is the question's own name; naming a choice takes whichever option it picked, so a defect
 * is listed as the kind it is; anything else is a literal.
 */
function labelOf(question, questions, answers) {
  const wanted = question.issue.label ?? 'self';
  if (wanted === 'self') return question.name;
  const named = questions.find(other => other.name === wanted && other.type === 'choice');
  return named ? answers[named.name]?.choice ?? wanted : wanted;
}

/**
 * Every issue a set of answers carries, strongest first. Nothing is filtered out beyond `min`: an issue at 8% is listed at 8% and
 * sorts to the bottom, where it belongs. Where two answers are both needed for a problem to be real they multiply, and where
 * several answers are the same kind of problem only the likeliest is listed, since one method has one worst vulnerability.
 */
export function issues(answers, min = 0, questions = questionSet(), rename = kind => kind) {
  const found = [], strongest = new Map();
  for (const question of questions) {
    if (!question.issue || answers[question.name] === undefined) continue;
    const raised = question.issue.on === false ? 1 - value(answers[question.name]) : gated(question, answers);
    const label = labelOf(question, questions, answers);
    if (question.issue.except && label === question.issue.except) continue;
    // A question saying how sure it has to be speaks for itself; the run's floor is for the ones that do not.
    // `from` is the question, which is what says whether the issue fails a run. The label cannot: it is often an answer rather
    // than a name, and a model that picks a word outside the options it was offered would walk straight past a gate.
    const issue = { type: question.issue.type, label: rename(label), from: question.name, probability: raised,
      floor: floorFor(question, min), text: `${rename(label)} ${Math.round(raised * 100)}%` };
    if (question.issue.pick !== 'strongest') { found.push(issue); continue; }
    const held = strongest.get(question.issue.type);
    if (!held || issue.probability > held.probability) strongest.set(question.issue.type, issue);
  }
  return [...found, ...strongest.values()].filter(issue => issue.probability > issue.floor).sort((a, b) => b.probability - a.probability);
}

/** The labels one question can raise: the options of the choice it names, or the one name it files under. */
export function labelsRaised(question, questions, rename = kind => kind) { return labelsOf(question, questions, rename); }
function labelsOf(question, questions, rename = kind => kind) {
  const wanted = question.issue?.label ?? 'self';
  const named = questions.find(other => other.name === wanted && other.type === 'choice');
  if (named) return Object.keys(named.options).filter(option => option !== question.issue.except).map(rename);
  return [rename(wanted === 'self' ? question.name : wanted)];
}

/**
 * The questions worth asking for a given filter. A filter that narrows a report to one kind of problem should narrow the run to
 * the questions that can raise it: asking thirty questions per method and printing two is paying for twenty-eight answers nobody
 * reads. What a kept question depends on comes with it — the gate it multiplies by, the choice that names it, and the severity
 * rubric when it is a correctness issue, since that is what ranks it.
 */
export function questionsFor(questions, filters = [], rename = kind => kind) {
  const named = filters.filter(clause => clause.key === 'type' || clause.key === 'kind');
  if (!named.length) return questions;
  const canon = value => String(value).toLowerCase().replace(/[_-]+/g, ' ');
  const wanted = new Set();
  for (const question of questions) {
    if (!question.issue) continue;
    const labels = labelsOf(question, questions, rename);
    if (named.some(clause => (clause.key === 'type' ? question.issue.type === clause.value : labels.some(label => canon(label) === clause.value)))) wanted.add(question.name);
  }
  for (const name of [...wanted]) {
    const question = questions.find(other => other.name === name);
    if (question.when) wanted.add(question.when);
    const label = question.issue.label ?? 'self';
    if (label !== 'self' && questions.some(other => other.name === label)) wanted.add(label);
    if (CORRECTNESS.has(question.issue.type)) wanted.add('severity');
  }
  return questions.filter(question => wanted.has(question.name));
}

/** The types a question set can raise, and the labels it can raise them under, so `--filter` can name them and reject a typo. */
export function vocabulary(questions = questionSet(), rename = kind => kind) {
  const types = new Set(), labels = new Set();
  for (const question of questions) {
    // A search declares no issue, because whether it is broken is decided over every unit rather than by one answer. It still
    // ends up on a row under its own name, so a filter and a closure have to be able to say that name.
    if (!question.issue) { if (SEARCHES(question.kind)) { types.add('lint'); labels.add(rename(question.name)); } continue; }
    types.add(question.issue.type);
    for (const label of labelsOf(question, questions, rename)) labels.add(label);
  }
  return { types: [...types], labels: [...labels] };
}
