/**
 * `perch lint`: rules you write, asked of your own code. A linter checks the things a parser can prove; this checks the things it
 * cannot — whether a comment says why, whether a listing honours a filter, whether a behaviour you claim is actually asserted
 * anywhere. Each rule is one typed question put to System One about one unit, so the answer is a probability and the same
 * hash-and-skip that keeps a scan cheap keeps a lint cheap: a unit whose code has not changed, under a rule whose wording has not
 * changed, is not asked about again.
 *
 * Findings do not go into `perch issues`. A rule is yours and a scan's questions are perch's, and mixing them would let a rule you
 * are still drafting pollute a list you trust.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { git, listTree } from './git.js';
import { analyzeTree } from './scan.js';
import { buildGraph } from './graph.js';
import { leadingComment, lineId, lineWindows, locateWhere, tagged, whereQuestion, whereWindowQuestion } from './questions.js';
import { findingId, openStore, sha256 } from './store.js';

/** Where rules live: one file until there are enough to split, then a directory of them. Both are source, both are reviewed. */
export const RULES_FILE = 'perch.yaml', RULES_DIR = 'perch';
/** A rule is believed to be broken when the model puts more than half its weight there, the same line the scan draws. */
export const BELIEVED = 0.5;
/** Units one rule may ask about in a single run, so a mistyped selector cannot spend a repository's worth of requests. */
export const MAX_UNITS = 400;
/**
 * Questions in flight at once. A scan reads eight because each of its requests carries a method's whole neighbourhood and thirty
 * questions; a lint request is one question about one unit and a few kilobytes, so it can go far wider. Overshooting a rate limit
 * is not a failure here — the client backs off and retries — so this is set to what the work is worth, not to what is safe.
 */
export const DEFAULT_PARALLEL = 32;

/**
 * `ensure` is asked of every unit and every unit has to satisfy it. The other two are asked of units in turn until one answers,
 * because the claim is about the codebase and not about any one file: `ensure_exist` passes at the first unit that has the thing,
 * `ensure_nexist` fails at the first unit that has it. Passing an exist rule is cheap and proving a nexist rule is not, which is
 * the right way round — proving an absence is the expensive claim.
 */
const KINDS = ['ensure', 'ensure_exist', 'ensure_nexist'];
const SEARCHES = kind => kind === 'ensure_exist' || kind === 'ensure_nexist';

/**
 * Rules are read from the working copy, not from the commit. They are what you are editing when you run this, and a linter that
 * answered yesterday's rule without saying so would waste an afternoon before anyone noticed. The code they are asked about still
 * comes from the revision, so a finding is still about a commit.
 */
export async function readRules(root, revision) {
  const paths = (await listTree(root, revision)).map(item => item.path)
    .filter(path => path === RULES_FILE || (path.startsWith(`${RULES_DIR}/`) && /\.ya?ml$/.test(path)))
    .sort();
  const rules = [];
  for (const path of paths) {
    const text = await readFile(join(root, path), 'utf8').catch(() => git(['show', `${revision}:${path}`], root));
    for (const [index, rule] of (parse(text) ?? []).entries()) rules.push(check(rule, path, index));
  }
  return rules;
}

/** A rule that cannot be understood is a mistake to fix now, not a rule to skip quietly at the point it would have caught something. */
function check(rule, path, index) {
  const at = `${path} rule ${index + 1}`;
  if (!rule?.name) throw new Error(`${at}: every rule needs a name`);
  const kind = KINDS.find(key => rule[key]);
  if (!kind) throw new Error(`${rule.name} (${at}): needs one of ${KINDS.join(', ')}`);
  if (!rule.where) throw new Error(`${rule.name} (${at}): needs where to say what it applies to`);
  if (rule.each && !['file', 'method', 'test'].includes(rule.each)) throw new Error(`${rule.name} (${at}): each is file, method or test, not ${rule.each}`);
  return { ...rule, kind, text: rule[kind], at, hash: sha256(JSON.stringify([rule[kind], rule.where, rule.except, rule.each])) };
}

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
export function selectUnits(rule, { scan, graph, files, tree }) {
  const source = rule.where;
  const spared = unit => !rule.except || ![rule.except].flat().some(glob => matches(glob, unit.path));
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
 * asserted, so a rule asking whether a behaviour is tested answers with a test rather than the file it is somewhere inside. A
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

/** The state and question for one rule against one unit. */
export function lintStep({ rule, unit, source }) {
  const state = { rule: rule.name, path: unit.path, ...(unit.part ? { name: unit.name, line: unit.line } : { file: unit.path }), source };
  if (SEARCHES(rule.kind)) {
    return { state, question: { found: { type: 'noul', instructions: { looking_for: rule.text, question: 'Is `looking_for` here, in the code below? Answer about this code alone; somewhere else having it is not this.' },
      criteria: { true: rule.text, false: `Not here: ${rule.text}` } } } };
  }
  return { state, question: { holds: { type: 'noul', instructions: { rule: rule.text, question: 'Is `rule` true of the code below?' },
    criteria: { true: rule.text, false: `Not so: ${rule.text}` } } } };
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
  const question = ids => ({ ...whereQuestion(ids), instructions: { rule: rule.ensure, question: 'Which line breaks `rule`? Pick the worst one.' } });
  const questions = windows ? { where_window: whereWindowQuestion(windows) } : { where: question(ids) };
  const { answers } = await locateWhere({ systemOne, state, questions, windows: windows?.map(window => window) });
  const chosen = answers.where?.choice;
  return chosen ? Number(String(chosen).slice(1)) : unit.line;
}

/** What one answer means: how sure the rule is broken, and the citation when there is one. */
export function readLint(rule, answers) {
  // For a search, the answer is whether the thing is here. What that means for the rule depends on which way it was asked.
  if (SEARCHES(rule.kind)) return { here: answers.found.noul, broken: rule.kind === 'ensure_nexist' ? answers.found.noul : 0, cite: null };
  return { broken: 1 - answers.holds.noul, cite: null };
}

/**
 * Run every rule over the units it selects. `paths` narrows to a diff, so a pull request asks only about what it touched; a unit
 * answered before under the same rule wording and the same code is read from the log rather than asked again.
 */
export async function lintRepository({ root, revision, out, analyzer, systemOne, paths = [], min = BELIEVED, force = false, parallel = DEFAULT_PARALLEL,
  onFile = () => {}, progress = () => {}, log = () => {}, debug = () => {} }) {
  const rules = await readRules(root, revision);
  if (!rules.length) throw new Error(`no rules: write ${RULES_FILE} or ${RULES_DIR}/*.yaml`);
  const tree = await listTree(root, revision);
  const scan = await analyzeTree({ root, revision, out, analyzer, log: debug, debug });
  const graph = buildGraph(scan.files);
  const files = new Map();
  const textOf = async path => {
    if (!files.has(path)) files.set(path, await git(['show', `${revision}:${path}`], root).catch(() => ''));
    return files.get(path);
  };
  for (const file of scan.files) await textOf(file.path);

  const cache = await readCache(out);
  const touched = path => !paths.length || paths.some(item => path === item || path.startsWith(item.replace(/\/$/, '') + '/'));
  const findings = [], recorded = new Map();
  let asked = 0, skipped = 0, unchecked = 0;
  const work = [], searches = [];
  for (const rule of rules) {
    const units = selectUnits(rule, { scan, graph, files, tree }).slice(0, MAX_UNITS);
    // A search asks its units in turn and stops, so it is ordered by how likely each is to hold the answer and kept apart from
    // the rules that ask everything. Word overlap is a poor judge and a free one, which beats a request spent on ranking.
    if (SEARCHES(rule.kind)) { searches.push({ rule, units: rank(rule, units) }); continue; }
    for (const unit of units) {
      // The key is the text the model is shown, not the unit's own hash: a method's hash covers its body, so keying on it
      // would hold an answer about a comment after the comment had been rewritten.
      const source = await textOf(unit.path);
      const body = unit.part ? bodyOf(source, unit) : source;
      const key = [rule.name, unit.id, rule.hash, sha256(body)].join(' ');
      if (!force && cache.has(shortKey(key))) { skipped++; const held = cache.get(shortKey(key)); if (held.broken > min) findings.push(held); work.push({ rule, unit, key, body, held }); continue; }
      // `--since` says what to ask about, not what to report. A file the branch did not touch, with no answer on record, is
      // counted as unchecked and named in the summary; one that has an answer keeps it, so the report covers the repository.
      if (!touched(unit.path)) { unchecked++; continue; }
      work.push({ rule, unit, key, body });
    }
  }
  // File order, so a file is finished before the next is started and can be reported the moment it is.
  work.sort((a, b) => a.unit.path.localeCompare(b.unit.path) || a.unit.line - b.unit.line);
  const checkedIn = new Map();
  for (const item of work) checkedIn.set(item.unit.path, (checkedIn.get(item.unit.path) ?? 0) + 1);
  let open = null, found = [];
  /** A file is only worth reporting once every rule has been asked of every part of it, which is when its pass rate is known. */
  const closeFile = () => { if (open) onFile({ path: open, checked: checkedIn.get(open) ?? 0, findings: found, rules }); open = null; found = []; };
  /** One rule against one unit: the question, and the second question a failing file gets about which line it failed on. */
  const askOne = async ({ rule, unit, key, body }) => {
    const { state, question } = lintStep({ rule, unit, source: body });
    debug(`${rule.name}: ${unit.name}`);
    const { answers } = await systemOne.ask(state, question);
    const { broken, cite } = readLint(rule, answers);
    // A file that failed is asked which line failed; a method already has one.
    const located = broken > min && !unit.part && rule.kind === 'ensure';
    const line = located ? await locateBreak({ systemOne, rule, unit, body }) : unit.line;
    // The located line, as text. A number alone makes a reader open the file to find out what was objected to. A method's row
    // already names the method, so repeating its declaration underneath says nothing.
    const onLine = located ? ((await textOf(unit.path)).split('\n')[line - 1] ?? '').trim() : '';
    const text = onLine.length > 110 ? `${onLine.slice(0, 110)}…` : onLine || null;
    return { key, finding: { rule: rule.name, rule_hash: rule.hash, unit: unit.id, path: unit.path, name: unit.name, line, end_line: unit.end_line ?? null, text, hash: unit.hash, broken, cite, at: new Date().toISOString() } };
  };

  // Asked `parallel` at a time, the way a scan reads methods. The answers are then taken in the order the work was sorted into,
  // so a file is still finished before the next one starts and the output still reads top to bottom.
  for (let at = 0; at < work.length; at += parallel) {
    const batch = work.slice(at, at + parallel);
    const answered = await Promise.all(batch.map(item => (item.held ? null : askOne(item))));
    for (const [index, item] of batch.entries()) {
      if (item.unit.path !== open) { closeFile(); open = item.unit.path; }
      const finding = item.held ?? answered[index].finding;
      if (!item.held) { recorded.set(answered[index].key, finding); progress(++asked, work.length); }
      if (finding.broken > min) { found.push(finding); if (!item.held) findings.push(finding); }
    }
  }
  closeFile();

  // Each search is sequential because it stops at its answer, but one search need not wait on another.
  await Promise.all(searches.map(async ({ rule, units }) => {
    const wanted = rule.kind === 'ensure_exist';
    let settled = null, missed = 0;
    for (const unit of units) {
      const source = await textOf(unit.path);
      const body = unit.part ? bodyOf(source, unit) : source;
      const key = [rule.name, unit.id, rule.hash, sha256(body)].join(' ');
      const seen = cache.get(shortKey(key));
      let here = seen?.here;
      // Kept whether it was asked now or read from the file: the file is rewritten whole, so an answer left out is an answer lost.
      if (seen) recorded.set(key, seen);
      if (here === undefined || force) {
        if (!touched(unit.path)) { unchecked++; missed++; continue; }
        const { state, question } = lintStep({ rule, unit, source: body });
        debug(`${rule.name}: ${unit.name}`);
        const { answers } = await systemOne.ask(state, question);
        ({ here } = readLint(rule, answers));
        recorded.set(key, { rule: rule.name, rule_hash: rule.hash, unit: unit.id, path: unit.path, name: unit.name, line: unit.line, hash: unit.hash, broken: wanted ? 0 : here, here, cite: null, at: new Date().toISOString() });
        asked++;
      } else skipped++;
      if (here > min) { settled = unit; break; }
    }
    // An exist rule that found nothing is one finding against the rule; a nexist rule that found something is one against the
    // unit holding it. Either way it is said once, not once per file that did not answer.
    // Not finding it among the units this run was allowed to look at is not the same as it not being there. A search that could
    // not see all its candidates says nothing rather than reporting an absence it did not establish.
    if (!settled && missed) return;
    const broken = wanted ? (settled ? 0 : 1) : (settled ? 1 : 0);
    if (broken > min) {
      const where = settled ?? { path: rule.where, name: rule.name, line: 1 };
      const finding = { rule: rule.name, rule_hash: rule.hash, unit: `search:${rule.name}`, path: where.path, name: settled ? where.name : rule.name, line: where.line ?? 1, broken, cite: null, at: new Date().toISOString() };
      findings.push(finding);
      onFile({ path: finding.path, checked: 1, findings: [finding], rules });
    }
  }));

  // Everything this run could use: what it asked, plus what it read from the file. Anything else is about code or a rule that
  // no longer exists, and keeping it is how the file grew without bound.
  for (const item of work) if (item.held && !recorded.has(item.key)) recorded.set(item.key, item.held);
  await writeCache(out, [...recorded]);

  // Broken rules join the issue log, so one list answers "what is wrong with this repository". A rule a unit no longer breaks is
  // cleared, or something fixed last week would sit in the list forever.
  const store = openStore(out);
  const seen = new Set();
  const listed = findings.map(finding => {
    const id = findingId(`${finding.rule}::${finding.unit}`);
    seen.add(id);
    return { ...finding, id, revision, end_line: finding.end_line ?? null, said: rules.find(rule => rule.name === finding.rule)?.text ?? null };
  });
  await store.recordLint(listed, [...(await store.indexes()).lint.keys()].filter(id => !seen.has(id)));
  log(`${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}, ${asked + skipped} checked, ${asked} read, ${skipped} from the log${unchecked ? `, ${unchecked} never checked` : ''}`);
  // Cached findings were never streamed, so they are sorted in with the rest for the report at the end.
  return { rules, checked: asked + skipped, asked, skipped, unchecked,
    findings: findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line) };
}

/**
 * Answers already given, keyed by the rule, the unit, the rule's wording and the code. Its own file, since a lint finding is not
 * an issue. It is meant to be carried between runs — a CI cache, or committed — so it is written short and rewritten whole each
 * time, keeping only the answers this run could still use. Appending forever cost two megabytes to say four thousand things.
 */
const cachePath = out => join(out, 'lint.jsonl');
const shortKey = key => sha256(key).slice(0, 16);
// `here` is what a search asked and is not derivable from `broken`, so it is kept: without it every search re-asks every run.
const packed = (key, finding) => JSON.stringify([shortKey(key), finding.rule, finding.unit, finding.path, finding.name, finding.line, Number(finding.broken.toFixed(3)), finding.cite ?? null, finding.here === undefined ? null : Number(finding.here.toFixed(3)), finding.text ?? null]);
const unpacked = line => {
  const [key, rule, unit, path, name, at, broken, cite, here, text] = JSON.parse(line);
  return [key, { rule, unit, path, name, line: at, broken, cite, text: text ?? null, ...(here === null || here === undefined ? {} : { here }) }];
};
async function readCache(out) {
  const text = await readFile(cachePath(out), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const cache = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    // The old shape was one object per line with the whole key in it; read it once so an existing file is not thrown away.
    if (line.startsWith('{')) { const entry = JSON.parse(line); cache.set(shortKey(entry.key), entry.finding); continue; }
    const [key, finding] = unpacked(line);
    cache.set(key, finding);
  }
  return cache;
}
/** Rewritten whole, keeping only what this run asked or could have asked. An answer to a rule or a line that is gone is dropped. */
async function writeCache(out, live) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(out, { recursive: true });
  await writeFile(cachePath(out), live.map(([key, finding]) => packed(key, finding)).join('\n') + '\n');
}

/** The files a pull request touched, so CI asks about the diff rather than the repository. */
export async function changedPaths(root, since) {
  const base = (await git(['merge-base', since, 'HEAD'], root)).trim();
  return (await git(['diff', '--name-only', `${base}..HEAD`], root)).split('\n').map(line => line.trim()).filter(Boolean);
}
