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
import { sha256 } from './store.js';

/** Where rules live: one file until there are enough to split, then a directory of them. Both are source, both are reviewed. */
export const RULES_FILE = 'perch.yaml', RULES_DIR = 'perch';
/** A rule is believed to be broken when the model puts more than half its weight there, the same line the scan draws. */
export const BELIEVED = 0.5;
/** Units one rule may ask about in a single run, so a mistyped selector cannot spend a repository's worth of requests. */
export const MAX_UNITS = 400;

const KINDS = ['ensure', 'behaviour', 'behavior'];

/** Rules come from the tree at a revision, not the working copy, so a lint result belongs to a commit like everything else. */
export async function readRules(root, revision) {
  const paths = (await listTree(root, revision)).map(item => item.path)
    .filter(path => path === RULES_FILE || (path.startsWith(`${RULES_DIR}/`) && /\.ya?ml$/.test(path)))
    .sort();
  const rules = [];
  for (const path of paths) {
    const text = await git(['show', `${revision}:${path}`], root);
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
  if (!rule.where && !rule.over && kind === 'ensure') throw new Error(`${rule.name} (${at}): needs where or over to say what it applies to`);
  if (rule.each && !['file', 'method'].includes(rule.each)) throw new Error(`${rule.name} (${at}): each is file or method, not ${rule.each}`);
  return { ...rule, kind: kind === 'behavior' ? 'behaviour' : kind, at, hash: sha256(JSON.stringify([rule.ensure ?? rule.behaviour ?? rule.behavior, rule.where, rule.over, rule.except, rule.each, rule.cite])) };
}

/** `**\/*.md` and `src/**\/*.js` as a test on a path. Only the two wildcards a rule file ever needs. */
export function matches(glob, path) {
  const segment = part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${glob.split('**/').map(segment).join('(?:.*/)?')}$`).test(path);
}

/**
 * The units a rule asks about. A glob names files, and `each: method` turns those into the methods inside them. The two graph
 * selectors name a set perch already knows: who calls a method, and which methods mention a thing by name. `mentions` is text, not
 * structure, and is honest about that — it finds the methods worth asking, not the methods that are guilty.
 */
export function selectUnits(rule, { scan, graph, files, tree }) {
  // A behaviour is one question about the whole suite, not one per file, and it is asked again when any cited test changes.
  if (rule.kind === 'behaviour') {
    const cited = tree.filter(item => item.type === 'blob' && matches(rule.cite ?? 'test/**', item.path));
    if (!cited.length) throw new Error(`${rule.name} (${rule.at}): cite matched no files`);
    return [{ id: `behaviour:${rule.name}`, path: cited[0].path, name: rule.name, line: 1, hash: sha256(cited.map(item => item.sha).join(' ')), cited: cited.map(item => item.path) }];
  }
  const source = rule.over ?? rule.where;
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
  // A method comes from the scan, which only holds what tree-sitter could parse. A file comes from the git tree, because a rule
  // about prose is a rule about markdown, and markdown is not a language the scan reads.
  if (rule.each === 'method') {
    return scan.files.filter(file => !file.test && matches(source, file.path))
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

const methodUnit = node => ({ id: node.id, path: node.path, name: node.qualified_name, line: node.line, end_line: node.end_line, hash: node.hash, method: true });
const sourceOf = (node, files) => (files.get(node.path) ?? '').split('\n').slice(node.line - 1, node.end_line).join('\n');

/** Test titles a citation can name: `it('...')` and `test('...')`, which is what a reader greps for anyway. */
export function testTitles(text) {
  // `it('x')`, `test.skip('x')`, and `it.each([...])('x')`, which is how a suite actually spells them.
  return [...text.matchAll(/^\s*(?:it|test)(?:\.\w+)*(?:\([^)]*\))?\(\s*(['"`])(.+?)\1/gm)].map(match => match[2]);
}

/** The state and question for one rule against one unit. */
export function lintStep({ rule, unit, source, titles = [] }) {
  const state = { rule: rule.name, path: unit.path, ...(unit.method ? { method: unit.name, line: unit.line } : { file: unit.path }), source };
  if (rule.kind === 'behaviour') {
    const criteria = { ...Object.fromEntries(titles.map(title => [title, `This test asserts it: "${title}"`])), none: 'No test here asserts this behaviour' };
    return { state: { behaviour: rule.behaviour, tests: titles, source }, question: { cite: { type: 'choice', instructions: { behaviour: rule.behaviour,
      question: 'Which of these tests asserts `behaviour`? Name it only if it checks the behaviour itself, not merely that the call did not throw.' }, criteria } } };
  }
  return { state, question: { holds: { type: 'noul', instructions: { rule: rule.ensure, question: 'Is `rule` true of the code below?' },
    criteria: { true: rule.ensure, false: `Not so: ${rule.ensure}` } } } };
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
  if (rule.kind === 'behaviour') {
    const choice = answers.cite.choice, probabilities = answers.cite.probabilities ?? {};
    return { broken: choice === 'none' ? (probabilities.none ?? 1) : 1 - (probabilities[choice] ?? 1), cite: choice === 'none' ? null : choice };
  }
  return { broken: 1 - answers.holds.noul, cite: null };
}

/**
 * Run every rule over the units it selects. `paths` narrows to a diff, so a pull request asks only about what it touched; a unit
 * answered before under the same rule wording and the same code is read from the log rather than asked again.
 */
export async function lintRepository({ root, revision, out, analyzer, systemOne, paths = [], min = BELIEVED, force = false,
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
  const findings = [], fresh = [];
  let asked = 0, skipped = 0;
  const work = [];
  for (const rule of rules) {
    for (const unit of selectUnits(rule, { scan, graph, files, tree }).slice(0, MAX_UNITS)) {
      if (!touched(unit.path)) continue;
      // The key is the text the model is shown, not the unit's own hash: a method's hash covers its body, so keying on it
      // would hold an answer about a comment after the comment had been rewritten.
      const source = await textOf(unit.path);
      const body = unit.method ? bodyOf(source, unit) : source;
      const key = [rule.name, unit.id, rule.hash, sha256(body)].join(' ');
      if (!force && cache.has(key)) { skipped++; const held = cache.get(key); if (held.broken > min) findings.push(held); work.push({ rule, unit, key, body, held }); continue; }
      work.push({ rule, unit, key, body });
    }
  }
  // File order, so a file is finished before the next is started and can be reported the moment it is.
  work.sort((a, b) => a.unit.path.localeCompare(b.unit.path) || a.unit.line - b.unit.line);
  const checkedIn = new Map();
  for (const item of work) checkedIn.set(item.unit.path, (checkedIn.get(item.unit.path) ?? 0) + 1);
  let open = null, found = [];
  /** A file is only worth reporting once every rule has been asked of every part of it, which is when its pass rate is known. */
  const closeFile = () => { if (open) onFile({ path: open, checked: checkedIn.get(open) ?? 0, findings: found }); open = null; found = []; };
  for (const { rule, unit, key, body, held } of work) {
    if (unit.path !== open) { closeFile(); open = unit.path; }
    if (held) { if (held.broken > min) found.push(held); continue; }
    const titles = rule.kind === 'behaviour' ? testTitles((await Promise.all(unit.cited.map(textOf))).join('\n')) : [];
    if (rule.kind === 'behaviour' && !titles.length) throw new Error(`${rule.name} (${rule.at}): the cited files hold no tests to name`);
    const { state, question } = lintStep({ rule, unit, source: body, titles });
    debug(`${rule.name}: ${unit.name}`);
    const { answers } = await systemOne.ask(state, question);
    const { broken, cite } = readLint(rule, answers);
    // A file that failed is asked which line failed; a method already has one.
    const line = broken > min && !unit.method && rule.kind === 'ensure' ? await locateBreak({ systemOne, rule, unit, body }) : unit.line;
    const finding = { rule: rule.name, rule_hash: rule.hash, unit: unit.id, path: unit.path, name: unit.name, line, hash: unit.hash, broken, cite, at: new Date().toISOString() };
    fresh.push([key, finding]);
    if (broken > min) { findings.push(finding); found.push(finding); }
    progress(++asked, work.length);
  }
  closeFile();
  await writeCache(out, fresh);
  log(`${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}, ${asked + skipped} checked, ${asked} read, ${skipped} unchanged`);
  // Cached findings were never streamed, so they are sorted in with the rest for the report at the end.
  return { rules, checked: asked + skipped, asked, skipped,
    findings: findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line) };
}

/** Answers already given, keyed by rule, unit, rule wording and code. Its own log, since a lint finding is not an issue. */
const cachePath = out => join(out, 'lint.jsonl');
async function readCache(out) {
  const text = await readFile(cachePath(out), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const cache = new Map();
  for (const line of text.split('\n').filter(Boolean)) { const entry = JSON.parse(line); cache.set(entry.key, entry.finding); }
  return cache;
}
async function writeCache(out, fresh) {
  if (!fresh.length) return;
  const { appendFile, mkdir } = await import('node:fs/promises');
  await mkdir(out, { recursive: true });
  await appendFile(cachePath(out), fresh.map(([key, finding]) => JSON.stringify({ key, finding })).join('\n') + '\n');
}

/** The files a pull request touched, so CI asks about the diff rather than the repository. */
export async function changedPaths(root, since) {
  const base = (await git(['merge-base', since, 'HEAD'], root)).trim();
  return (await git(['diff', '--name-only', `${base}..HEAD`], root)).split('\n').map(line => line.trim()).filter(Boolean);
}
