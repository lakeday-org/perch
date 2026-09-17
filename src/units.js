/**
 * The units a rule is asked about, and how one question about one unit is put and read.
 *
 * A scan reads methods, and a rule about a method rides along in that method's own request. The rest do not fit there: a rule
 * about prose is a rule about markdown, which the graph has never heard of, and a rule about a test is about one block inside a
 * file. Those are selected here and asked here.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git, listTree } from './git.js';
import { askKey, BUILTIN, compile, floorFor, installQuestions, merge, parseQuestions, SEARCHES } from './ask.js';
import { leadingComment, lineId, lineWindows, locateWhere, tagged, whereQuestion, whereWindowQuestion } from './questions.js';
import { findingId } from './store.js';

/** Where rules live: one file until there are enough to split, then a directory of them. Both are source, both are reviewed. */
export const RULES_FILE = 'perch.yaml', RULES_DIR = 'perch';
/** A rule is believed to be broken when the model puts more than half its weight there, the same line the scan draws. */
export const BELIEVED = 0.5;
/** Units one rule may ask about in a single run, so a mistyped selector cannot spend a repository's worth of requests. */
export const MAX_UNITS = 400;
/**
 * Questions in flight at once when the unit is not a method. A method's request carries its whole neighborhood and thirty
 * questions; this is one question about one unit and a few kilobytes, so it can go far wider. Overshooting a rate limit is not a
 * failure here, since the client backs off and retries, so this is set to what the work is worth rather than to what is safe.
 */
export const UNIT_PARALLEL = 32;

/** Neighbours one rule may be shown, so `sees: callers` on a method a hundred things call is still one request. */
export const MAX_SEEN = 8;

/**
 * Rules are read from the working copy, not from the commit. They are what you are editing when you run this, and a linter that
 * answered yesterday's rule without saying so would waste an afternoon before anyone noticed. The code they are asked about still
 * comes from the revision, so a finding is still about a commit.
 */
export async function readRules(root, revision) {
  const wanted = path => path === RULES_FILE || (path.startsWith(`${RULES_DIR}/`) && /\.ya?ml$/.test(path));
  const committed = (await listTree(root, revision)).map(item => item.path).filter(wanted);
  // A rule file that is on disk and not yet committed is still a rule file. Taking the list from the commit meant `perch rules
  // add` wrote a rule that nothing asked until someone committed it, and said nothing about why.
  const here = [RULES_FILE, ...(await readdir(join(root, RULES_DIR)).catch(() => [])).map(name => `${RULES_DIR}/${name}`)].filter(wanted);
  const paths = [...new Set([...committed, ...here])].sort();
  const rules = [];
  for (const path of paths) {
    const text = await readFile(join(root, path), 'utf8').catch(() => git(['show', `${revision}:${path}`], root).catch(() => null));
    if (text === null) continue;
    rules.push(...parseQuestions(text, path, 'rule'));
  }
  // A repository's own file can reword a question perch ships as well as add one, and a report of either has to be able to look
  // up what raised it, so the set in force is the two together.
  installQuestions(merge(BUILTIN, rules));
  // Everything the file holds, including a question written out longhand. `perch rules list` shows what is in there, and a file
  // that asks something perch will ask must not be able to hide it.
  return rules;
}

/** A question written longhand has no `kind`, and is asked of a method inside the walk rather than run over files and tests
 * here. So this is the split between the two, not a narrowing of one. */
export const asRules = questions => questions.filter(question => question.kind);

/** `**\/*.md` and `src/**\/*.js` as a test on a path. Only the two wildcards a rule file ever needs. */
export function matches(glob, path) {
  const segment = part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${glob.split('**/').map(segment).join('(?:.*/)?')}$`).test(path);
}

/**
 * The units a rule asks about. `where` takes a glob, which names files, and `each: method` turns those into the methods inside
 * them. It also takes two selectors over what perch already knows: `callers of <method>` from the call graph, and
 * `mentions <text>`, which is a text match and finds the methods worth asking rather than the methods that are guilty.
 */
export function selectUnits(rule, { scan, graph, files, tree, inScope = () => true }) {
  const source = rule.where;
  // The rule file is not code. A rule over `**/*` would otherwise be asked about the file that declares it, and answer about the
  // wording of its own question.
  const ours = path => path === RULES_FILE || path.startsWith(`${RULES_DIR}/`);
  // `except` is the rule's own exclusion; `inScope` is the run's, which --since narrows to what a branch changed.
  const spared = unit => inScope(unit.path) && !ours(unit.path) && (!rule.except || ![rule.except].flat().some(glob => matches(glob, unit.path)));
  const callers = /^callers? of (.+)$/.exec(source ?? '');
  const mentions = /^(?:writers? of|mentions) (.+)$/.exec(source ?? '');
  if (callers) {
    const target = [...graph.nodes.keys()].filter(id => id === callers[1] || id.endsWith(`::${callers[1]}`));
    if (!target.length) throw new Error(`${rule.name} (${rule.at}): no method named ${callers[1]}`);
    return [...new Set(target.flatMap(id => graph.callers(id)))].map(id => methodUnit(graph.nodes.get(id))).filter(spared);
  }
  if (mentions) {
    const needle = mentions[1].trim();
    return [...graph.nodes.values()].filter(node => !node.test && sourceOf(node, files).includes(needle)).map(methodUnit).filter(spared);
  }
  if (rule.each === 'test') {
    return tree.filter(item => item.type === 'blob' && matches(source, item.path))
      .flatMap(item => testBlocks(files.get(item.path) ?? '', item.path).map(unit => ({ ...unit, hash: item.sha }))).filter(spared);
  }
  // A method comes from the scan, which only holds what tree-sitter could parse. A file comes from the git tree, because a rule
  // about prose is a rule about markdown, and markdown is not a language the scan reads.
  if (rule.each === 'method') {
    return scan.files.filter(file => (SEARCHES(rule.kind) || !file.test) && matches(source, file.path))
      .flatMap(file => file.methods.map(method => methodUnit({ ...method, path: file.path }))).filter(spared);
  }
  return tree.filter(item => item.type === 'blob' && matches(source, item.path))
    .map(item => ({ id: item.path, path: item.path, name: item.path, line: 1, hash: item.sha })).filter(spared);
}

export function bodyOf(text, unit) {
  const lines = text.split('\n');
  const comment = leadingComment(lines, unit.line);
  return (comment ? `${comment}\n` : '') + lines.slice(unit.line - 1, unit.end_line).join('\n');
}

const methodUnit = node => ({ id: node.id, path: node.path, name: node.qualified_name, line: node.line, end_line: node.end_line, hash: node.hash, method: true, part: true });
const sourceOf = (node, files) => (files.get(node.path) ?? '').split('\n').slice(node.line - 1, node.end_line).join('\n');

/**
 * The tests in a file, as units. A test is what a suite is made of and what a person names when they say where something is
 * asserted, so a rule asking whether a behavior is tested answers with a test rather than the file it is somewhere inside. A
 * block runs to the line before the next one starts, which is enough to read one test and cheaper than matching braces.
 */
export function testBlocks(text, path) {
  const lines = text.split('\n');
  const found = [];
  for (const [index, line] of lines.entries()) {
    const match = /^\s*(?:it|test)(?:\.\w+)*(?:\([^)]*\))?\(\s*(['"`])(.+?)\1/.exec(line);
    if (match) found.push({ line: index + 1, name: match[2] });
  }
  return found.map((item, index) => ({ id: `${path}::${item.name}`, path, name: item.name, line: item.line,
    end_line: (found[index + 1]?.line ?? lines.length + 1) - 1, part: true }));
}

/** Units most likely to hold what a search is looking for, first. Shared words between the rule and the unit's name and path. */
export function rank(rule, units) {
  const wanted = new Set(String(rule.text).toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const score = unit => (`${unit.path} ${unit.name}`.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(word => wanted.has(word)).length;
  return [...units].sort((a, b) => score(b) - score(a));
}

/**
 * What a rule is shown besides the unit itself. Most rules want nothing else: a claim about one method is answered by that method,
 * and three neighbours in view are three other methods the model can answer about by mistake. A rule that genuinely spans two
 * places says so, and `sees:` is how — a test rule that asks whether the code under test is really asserted needs the code under
 * test, and no amount of rewording gets it from the test alone.
 *
 * A method's neighbours come from the call graph. A file's or a test's do not, because neither is a node in it, so what they call
 * is found by name: a declaration whose short name appears in the body, riskiest first.
 */
export function neighbourhood(sees, unit, { graph, files, max = MAX_SEEN }) {
  if (!sees || sees === 'self') return {};
  const text = files.get(unit.path) ?? '';
  if (sees === 'file') return { file_source: text };
  const body = unit.part ? bodyOf(text, unit) : text;
  const risk = id => graph.nodes.get(id)?.metrics?.risk_score ?? 0;
  const show = ids => [...new Set(ids)].sort((a, b) => risk(b) - risk(a)).slice(0, max)
    .map(id => graph.nodes.get(id)).filter(Boolean)
    .map(node => ({ name: node.qualified_name, path: node.path, source: sourceOf(node, files) }));
  // A file and a test are not nodes in the call graph, so what they call is found by name: a declaration whose short name
  // appears in the body, riskiest first.
  const named = [...graph.nodes.keys()].filter(id => new RegExp(`\\b${id.split('::').at(-1).split('.').at(-1).replace(/[^\w]/g, '')}\\b`).test(body));
  const seen = {};
  if (sees === 'calls' || sees === 'neighbors') seen.calls = show(named);
  if (sees === 'callers' || sees === 'neighbors') seen.called_by = show([...graph.nodes.keys()].filter(id => sourceOf(graph.nodes.get(id), files).includes(unit.name)));
  return seen;
}

/**
 * The state one context is asked over, and every rule's question about it. Each question is scored against the state on its own,
 * so asking twelve together answers the same as asking them one at a time and pays for the state once instead of twelve times.
 */
export function unitStep({ rules, unit, source, seen = {} }) {
  const state = { path: unit.path, ...(unit.part ? { name: unit.name, line: unit.line } : { file: unit.path }), source, ...seen };
  return { state, questions: compile(rules) };
}

/**
 * Where a broken rule is broken. A whole file scored 68% tells you nothing you can act on, so a file that fails is asked a second
 * question: which line. Only failing files are asked, so a clean run still costs one request each.
 */
export async function locateBreak({ systemOne, rule, unit, body }) {
  const lines = body.split('\n');
  const ids = lines.map((text, index) => (text.trim() ? lineId(index + 1) : null)).filter(Boolean);
  if (ids.length < 2) return unit.line;
  const windows = lineWindows(ids);
  const state = { rule: rule.name, path: unit.path, source: tagged(lines, 1) };
  const question = ids => ({ ...whereQuestion(ids), instructions: { rule: rule.text, question: 'Which line breaks `rule`? Pick the worst one.' } });
  const questions = windows ? { where_window: whereWindowQuestion(windows) } : { where: question(ids) };
  const { answers } = await locateWhere({ systemOne, state, questions, windows: windows?.map(window => window) });
  const chosen = answers.where?.choice;
  return chosen ? Number(String(chosen).slice(1)) : unit.line;
}

/** What one answer means: how sure the rule is broken, and the citation when there is one. */
export function readLint(rule, answers) {
  const said = answers[rule.name].noul;
  // For a search, the answer is whether the thing is here. What that means for the rule depends on which way it was asked: a rule
  // that wants the thing present is not broken by one unit lacking it, only by every unit lacking it, which the search decides.
  if (SEARCHES(rule.kind)) return { here: said, broken: rule.kind === 'ensure_absent' ? said : 0, cite: null };
  return { broken: 1 - said, cite: null };
}

/**
 * The rules that cover a method. They ride in that method's own request rather than costing one each: every question in a request
 * is scored against the state on its own, and the state is what the request is mostly made of, so a method covered by five rules
 * is one reading and not six.
 */
export const rulesForMethod = (rules, node) => rules.filter(rule => rule.kind === 'ensure' && rule.each === 'method'
  && matches(String(rule.where), node.path)
  && (!rule.except || ![rule.except].flat().some(glob => matches(glob, node.path))));

/**
 * The same verdict twice, flat and under `lint`, because a check has to read two ways: as a row in the issue list beside methods
 * the scan read, and as the record of a rule having been asked. A check that passed is written down as well, with nothing to
 * report, since that is what lets the next run skip asking it.
 */
const checkOf = (rule, unit, { broken, line, text, revision, key }) => ({
  type: 'checked', at: new Date().toISOString(), id: findingId(`${rule.name}::${unit.id}`), rule: rule.name, rule_hash: rule.hash,
  unit: unit.id, method: unit.method ? unit.id : null, path: unit.path, name: unit.name, line, end_line: unit.end_line ?? null,
  text, hash: unit.hash, key, revision, said: rule.text, broken,
  lint: { rule: rule.name, broken, text: rule.text, said: rule.text },
});

/**
 * Every rule that is not about a method, asked of every unit it selects. One question, one unit, one request, `parallel` of them
 * at a time, and a second question to a file that failed about which line failed on it.
 */
export async function askUnits({ rules, scan, graph, files, tree, revision, systemOne, inScope, min = BELIEVED,
  earlier = new Map(), parallel = UNIT_PARALLEL, progress = () => {}, debug = () => {} }) {
  // One request per context. Two rules about the same file that want to see the same thing are one reading, since every question
  // in a request is scored against the state by itself.
  const contexts = new Map();
  for (const rule of rules) {
    for (const unit of selectUnits(rule, { scan, graph, files, tree, inScope }).slice(0, MAX_UNITS)) {
      const key = `${unit.id}\u0000${rule.sees}`;
      if (!contexts.has(key)) contexts.set(key, { unit, sees: rule.sees, rules: [] });
      contexts.get(key).rules.push(rule);
    }
  }
  // File order, so a run reads top to bottom and two runs over the same tree ask in the same order.
  const work = [...contexts.values()].sort((a, b) => a.unit.path.localeCompare(b.unit.path) || a.unit.line - b.unit.line);
  const askOne = async ({ unit, sees, rules: over }) => {
    const source = files.get(unit.path) ?? '';
    const body = unit.part ? bodyOf(source, unit) : source;
    const { state, questions } = unitStep({ rules: over, unit, source: body, seen: neighbourhood(sees, unit, { graph, files }) });
    const key = askKey([{ state }], over);
    // Nothing about this unit or these rules has changed since it was last asked, so the answer cannot have either.
    const before = over.map(rule => earlier.get(findingId(`${rule.name}::${unit.id}`))).filter(check => check?.key === key);
    if (before.length === over.length) { debug(`${over.map(rule => rule.name).join(', ')}: ${unit.name} is unchanged`); return { results: before, carried: before.length }; }

    debug(`${over.map(rule => rule.name).join(', ')}: ${unit.name}`);
    const { answers } = await systemOne.ask(state, questions);
    // A file that failed is asked which line failed; a method or a test block already has one. One question per broken rule,
    // since two rules broken in one file are rarely broken on the same line.
    const results = await Promise.all(over.map(async rule => {
      const broken = readLint(rule, answers).broken;
      const failing = broken > floorFor(rule, min);
      const line = failing && !unit.part ? await locateBreak({ systemOne, rule, unit, body }) : unit.line;
      const onLine = failing && !unit.part ? (source.split('\n')[line - 1] ?? '').trim() : '';
      return checkOf(rule, unit, { broken, line, text: onLine.length > 110 ? `${onLine.slice(0, 110)}…` : onLine || null, revision, key });
    }));
    return { results, carried: 0 };
  };

  const results = [], total = work.reduce((count, item) => count + item.rules.length, 0);
  let asked = 0, carried = 0;
  for (let at = 0; at < work.length; at += parallel) {
    const batch = work.slice(at, at + parallel);
    const answered = await Promise.all(batch.map(askOne));
    for (const [index, item] of batch.entries()) {
      asked += item.rules.length;
      carried += answered[index].carried;
      progress(asked, total);
      results.push(...answered[index].results);
    }
  }
  return { results, asked, carried };
}

/**
 * The rules that are claims about the codebase rather than about any one file. Each asks its units in turn, ordered by how likely
 * each is to hold the answer, and stops at the first that answers. Word overlap is a poor judge of that and a free one, which
 * beats a request spent on ranking. One search need not wait on another.
 */
export async function searchUnits({ rules, scan, graph, files, tree, revision, systemOne, inScope, min = BELIEVED,
  earlier = new Map(), parallel = UNIT_PARALLEL, progress = () => {}, debug = () => {} }) {
  // What each search would read, worked out before anything is sent, so the run can say how much there is to get through. A
  // search stops at its answer, so this is the most it will read and not what it will read.
  const plans = rules.map(rule => {
    const units = rank(rule, selectUnits(rule, { scan, graph, files, tree, inScope }).slice(0, MAX_UNITS));
    // A search is about the codebase, so its answer depends on every unit it would read and not just the one it stops at. The
    // key is all of them, in the order it would read them. A search that is shown more than its unit is not keyed on what it was
    // shown, so it is asked again rather than reused on a guess.
    const id = findingId(`${rule.name}::search`);
    const key = rule.sees === 'self' ? askKey([{ state: units.map(unit => [unit.id, unit.hash ?? null]) }], [rule]) : null;
    return { rule, units, id, key, before: earlier.get(id) };
  });
  const carrying = plans.filter(plan => plan.key && plan.before?.key === plan.key);
  const running = plans.filter(plan => !carrying.includes(plan));
  const most = running.reduce((total, plan) => total + plan.units.length, 0);

  const results = carrying.map(plan => { debug(`${plan.rule.name} has nothing new to search`); return plan.before; });
  let asked = 0;
  const askOne = async (rule, unit) => {
    const source = files.get(unit.path) ?? '';
    const body = unit.part ? bodyOf(source, unit) : source;
    const { state, questions } = unitStep({ rules: [rule], unit, source: body, seen: neighbourhood(rule.sees, unit, { graph, files }) });
    debug(`${rule.name}: ${unit.name}`);
    const { answers } = await systemOne.ask(state, questions);
    return readLint(rule, answers).here > min;
  };

  await Promise.all(running.map(async ({ rule, units, id, key }) => {
    // A search with nothing to search has nothing to say. Under --since the universe is what the branch touched, so a rule over
    // test files on a branch that touched none would otherwise report that nobody has the thing, which is a claim it never
    // tested. perch doctor lists a rule that covered nothing, which is where an empty search belongs.
    if (!units.length) return;
    // Read in batches rather than one at a time. The answer is the same either way, since the first unit in ranked order that
    // has the thing is the one taken however many were read alongside it; what changes is that a search over four hundred
    // methods is a minute rather than most of an hour. At most one batch is spent past the answer.
    let settled = null;
    for (let at = 0; at < units.length && !settled; at += parallel) {
      const batch = units.slice(at, at + parallel);
      const here = await Promise.all(batch.map(unit => askOne(rule, unit)));
      asked += batch.length;
      progress(asked, most);
      const found = here.indexOf(true);
      if (found >= 0) settled = batch[found];
    }
    // A rule wanting the thing present is broken by nobody having it; one wanting it absent is broken by the unit that has it.
    // Either way it is said once, not once per file that did not answer. Nothing having it means no file to point at, so it is
    // reported against the rule file, where the claim is, and named for what it looked through.
    const broken = (rule.kind === 'ensure_present') === Boolean(settled) ? 0 : 1;
    const where = settled ?? { id: `search:${rule.name}`, path: RULES_FILE, name: String(rule.where), line: 1 };
    results.push({ ...checkOf(rule, where, { broken, line: where.line ?? 1, text: null, revision, key }), id });
  }));
  return { results, asked, carried: carrying.length };
}

/** The files a pull request touched, so CI asks about the diff rather than the repository. */
export async function changedPaths(root, since) {
  const base = (await git(['merge-base', since, 'HEAD'], root)).trim();
  return (await git(['diff', '--name-only', `${base}..HEAD`], root)).split('\n').map(line => line.trim()).filter(Boolean);
}
