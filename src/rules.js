/**
 * Editing `perch.yaml` from the command line. The file is yours to write by hand and always will be, but adding a rule mid-thought
 * should not mean stopping to find the file, and an agent that spots a pattern worth a rule has no business rewriting YAML by
 * string surgery. An edit writes the lines it changed and nothing else: every other rule, comment and blank line is put back
 * byte for byte.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Document, isMap, Pair, parseDocument, Scalar } from 'yaml';
import { BUILTIN, check, ENSURES, SCAN_YAML, SHAPES, parseQuestions } from './ask.js';
import { RULES_DIR, RULES_FILE, readRuleFiles } from './units.js';
import { revision } from './git.js';

export { SHAPES };

/**
 * Every key the grammar has, in the order they read best. A rule you write and a question perch ships are the same thing written
 * the same way, so this is the whole of it rather than the yes-or-no corner of it.
 */
export const KINDS = ENSURES;
export const FIELDS = ['name', 'disabled', 'type', 'each', 'where', 'except', 'sees', 'when', 'min', 'gate', ...KINDS, 'ask', 'true', 'false', 'options', 'levels', 'issue'];
/** Written out by `ensure`, so a rule that is given one has to lose whatever it had spelled out longhand, and the other way round. */
const EXPANDED = ['type', 'ask', 'true', 'false', 'options', 'levels'];
/** Keys whose value is a map or a list rather than a line, so they are built as nodes rather than set as scalars. */
const NESTED = new Set(['options', 'levels', 'issue']);

/**
 * The file as a document rather than a value, so comments and spacing come back out the way they went in.
 *
 * A file that is not there reads as an empty one and not as `[]`, which parses to a flow sequence and would write the first rule
 * as `[ { name: r1, ... } ]`. Every later edit reparses that and keeps the style, so one missing file at the start meant a rule
 * file nobody could read from then on.
 */
async function open(root, file = RULES_FILE) {
  const path = join(root, file);
  const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const doc = parseDocument(text);
  const empty = !doc.contents;
  if (!doc.contents || !doc.contents.items) doc.contents = doc.createNode([]);
  const keyless = isMap(doc.contents) && !doc.contents.flow && !doc.has('rules');
  const rules = rulesOf(doc);
  const origin = new Map();
  const before = place(text, rules, origin);
  // A new rule goes after the last one there. A file with none takes it at the end: as it comes when the file holds nothing but
  // comments, and under a rules: key when the file is a map that has not got one yet.
  const end = empty ? { to: text.length, dash: 0 } : keyless ? { to: text.length, dash: 2, under: 'rules:\n' } : before.at(-1)?.at;
  // The text it was parsed from goes back with it, because the write is made against that text and has to know it is putting
  // it down over the one it picked up.
  return { path, file, doc, rules, text, before, origin, end };
}

/**
 * The sequence the rules are in. The file is either a list of them or a map with them under `rules:`, and everything that edits
 * one works on the sequence either way. Reading `doc.contents` on the map form gave the pairs `ignore` and `rules` themselves,
 * so adding a rule wrote a node where a key belonged and the next command could not parse the file.
 */
function rulesOf(doc) {
  if (doc.contents?.items?.every(item => item?.key === undefined)) return doc.contents;
  const under = doc.get('rules', true);
  if (under?.items) return under;
  // A map with no rules in it yet: give it the key rather than making the caller notice which shape it has.
  doc.set('rules', doc.createNode([]));
  return doc.get('rules', true);
}

/**
 * Every edit reads the whole rule file and writes the whole rule file, so two at once both start from what was there before and
 * the second puts down a document the first is missing from. Held apart by a lock file, which exists or does not: creating one
 * with `wx` is the one thing a filesystem will only let a single caller do.
 *
 * A lock left by something that died would wedge the file for good, so waiting for one is given up on rather than waited out,
 * and the message says what to delete.
 */
async function withLock(root, file, work) {
  const path = join(root, file);
  const lock = `${path}.lock`;
  // A split file named for the first time has no directory yet, and the lock goes in it before the file does.
  await mkdir(dirname(path), { recursive: true });
  for (let tries = 0; ; tries++) {
    try { await writeFile(lock, `${process.pid}\n`, { flag: 'wx' }); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (tries >= 50) throw new Error(`${file} is being edited by another perch. If none is running, delete ${file}.lock`, { cause: error });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await work(); } finally { await rm(lock, { force: true }); }
}

/**
 * Written beside the file and moved onto it, the way the store writes everything else. A rule file is parsed by every verb, so a
 * write killed partway leaves one nobody can list, edit or remove: the wedge the comment over `legible` is about, arrived at from
 * the other direction. A rename cannot half happen, so the file is either the old set of rules or the new one.
 *
 * The lock holds other perch commands off, and this holds off everything else: an editor with the file open, a script, a hand.
 * Read again and refused if it moved, which turns losing somebody's rule into being told to run the command again.
 */
async function save(page) {
  const { path, file, text } = page;
  const now = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  if (now !== text) throw new Error(`${file} changed while perch was editing it, so nothing was written. Run that again.`);
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, rewrite(page));
  await rename(tmp, path);
}

/** What a node holds, as text two of them can be compared by. */
const plain = node => JSON.stringify(node);

/** Lines moved right or left by a number of columns. A blank line stays blank, and nothing moved by nothing is not touched. */
const shift = (text, by) => (by > 0 ? text.replace(/^(?=.)/gm, ' '.repeat(by)) : by < 0 ? text.replace(new RegExp(`^ {0,${-by}}`, 'gm'), '') : text);

/**
 * Where each rule and each of its keys sits in the text it was parsed from, so a write can put back what an edit left alone as
 * it was typed. The stringifier cannot: it wraps folded text at its own width, pads a flow list and settles comments where it
 * likes, so putting the whole document through it changed rules nobody had asked to change.
 *
 * A key's lines run from the end of the key before it, which takes in the comment written over it. A rule written in braces on
 * its dash is placed whole, with no keys to keep. One laid out any other way is given no place, and an edit that touches it
 * writes the whole document.
 */
function place(text, rules, origin) {
  const lineOf = at => text.lastIndexOf('\n', at - 1) + 1;
  // A value with nothing in it ends before its line does.
  const lineEnd = at => (text[at - 1] === '\n' ? at : at + /^[ \t]*(?:\r?\n)?/.exec(text.slice(at))[0].length);
  return rules.items.map(item => {
    const was = plain(item);
    if (!isMap(item) || !item.range || item.items.some(pair => !pair.key?.range || !pair.value?.range)) return { item, was };
    const from = lineOf(item.range[0]);
    const lead = text.slice(from, item.range[0]);
    if (!/^ *- +$/.test(lead)) return { item, was };
    const column = lead.length;
    const at = { from, to: lineEnd(item.range[2]), dash: lead.indexOf('-'), column };
    if (item.flow || !item.items.length) return { item, was, at };
    const keys = [];
    at.to = from;
    for (const pair of item.items) {
      const start = pair === item.items[0] ? from : lineOf(pair.key.range[0]);
      if (start < at.to || (start > from && text.slice(start, pair.key.range[0]) !== ' '.repeat(column))) return { item, was };
      const end = lineEnd(pair.value.range[2]);
      const own = (start === from ? ' '.repeat(column) : '') + text.slice(start === from ? item.range[0] : start, end);
      keys.push([pair, { gap: text.slice(at.to, start), own: own.endsWith('\n') ? own : `${own}\n`, column, was: plain(pair.value) }]);
      at.to = end;
    }
    for (const [pair, placed] of keys) origin.set(pair, placed);
    return { item, was, at };
  });
}

/** A node written fresh, at the column it goes in, folding where the whole file written fresh would have folded. */
const render = (node, column) => shift(new Document(node).toString({ lineWidth: Math.max(20, 80 - column) }), column);

/**
 * One rule as its lines: a key the edit left alone comes back as it was typed, and one it set or added is written fresh. A rule
 * in braces has no lines of its own to keep, so it is written fresh whole.
 */
function written(item, dash, column, origin) {
  const keys = item.flow ? [['', render(item, column)]] : item.items.map(pair => {
    const from = origin.get(pair);
    const kept = from && from.was === plain(pair.value);
    return [from ? shift(from.gap, column - from.column) : '',
      kept ? shift(from.own, column - from.column) : render(new Pair(pair.key?.value ?? pair.key, pair.value), column)];
  });
  return keys.map(([gap, own], index) => gap + (index ? own : `${' '.repeat(dash)}-${own.slice(dash + 1)}`)).join('');
}

/**
 * The file with the edit in it and every line the edit did not touch as it was. A rule that changed has its own lines replaced,
 * one that went is cut out with the comment over it, and a new one goes after the last.
 *
 * What comes out is read back before it is trusted, since a file that parses to something other than the rules that were meant
 * is worse than one that was rewrapped. Where the text cannot be worked on, or does not read back, the whole document is written
 * the way it always was: a file left with no rules in it, or a list of them written in brackets.
 */
function rewrite({ doc, rules, text, before, origin, end }) {
  const whole = () => String(doc);
  const edits = [];
  for (const [index, { item, was, at }] of before.entries()) {
    const gone = !rules.items.includes(item);
    if (!gone && plain(item) === was) continue;
    if (!at) return whole();
    if (!gone) edits.push([at.from, at.to, written(item, at.dash, at.column, origin)]);
    // The comment over a rule is about that rule, so it goes too. The first has nothing over it and takes the gap under it.
    else if (index) edits.push([before[index - 1].at?.to ?? at.from, at.to, '']);
    else edits.push([at.from, at.to + /^(?:[ \t\r]*\n)*/.exec(text.slice(at.to))[0].length, '']);
  }
  const added = rules.items.filter(item => !before.some(known => known.item === item));
  if (added.length) {
    if (!end || !added.every(isMap)) return whole();
    const lines = added.map(item => written(item, end.dash, end.dash + 2, origin)).join('');
    edits.push([end.to, end.to, (end.to && text[end.to - 1] !== '\n' ? '\n' : '') + (end.under ?? '') + lines]);
  }
  if (!rules.items.length) return whole();
  // New lines end the way the file's lines do.
  const ending = lines => (text.includes('\r\n') ? lines.replace(/\r?\n/g, '\r\n') : lines);
  const next = edits.sort(([a], [b]) => b - a).reduce((out, [from, to, lines]) => out.slice(0, from) + ending(lines) + out.slice(to), text);
  const back = parseDocument(next);
  return !back.errors.length && plain(back) === plain(doc) ? next : whole();
}

/**
 * A question perch ships, as the node scan.yaml holds it. Its keys are placed against scan.yaml's own text, so a copy in your
 * file is worded and wrapped the way perch wrote it. Read fresh each time, because an edit changes the node it is given.
 */
function shipped(name, origin) {
  const rules = rulesOf(parseDocument(SCAN_YAML));
  place(SCAN_YAML, rules, origin);
  return rules.items[named(rules, name)];
}

const named = (rules, name) => rules.items.findIndex(item => item.get?.('name') === name);

/** Prose reads as a folded block, the way the rules written by hand do; a path or a word stays on its line. */
function scalar(value) {
  const node = new Scalar(String(value));
  if (String(value).length > 60) node.type = Scalar.BLOCK_FOLDED;
  return node;
}

/** One key as it goes into the file: prose folds, a map or a list becomes a node, and anything else is written as it came. */
const write = (doc, key, value) => (NESTED.has(key) ? doc.createNode(value)
  : KINDS.includes(key) || key === 'ask' || key === 'true' || key === 'false' ? scalar(value) : value);

/**
 * A rule is put through the same reading a scan gives it before it is written down. Writing one the next command refuses leaves
 * the file wedged: every verb parses it, so a rule perch cannot understand stops you listing, editing or removing anything.
 */
const legible = (rule, file = RULES_FILE) => check(Object.fromEntries(Object.entries(rule).filter(([, value]) => value !== undefined)), file, 'rule');

/**
 * The files a rule may be written to: the root file, or a YAML file under `.perch/rules/`. Anything else is a path a scan would
 * never read, so a rule written there would be a rule nothing asks.
 */
export function ruleFile(file) {
  const path = String(file).split('\\').join('/').replace(/^\.\//, '');
  if (path === RULES_FILE || (path.startsWith(`${RULES_DIR}/`) && /\.ya?ml$/.test(path))) return path;
  throw new Error(`a rule file is ${RULES_FILE} or a .yaml file under ${RULES_DIR}/, not ${file}`);
}

/** Every file that defines a rule by that name, in the order a scan reads them: the last one is the definition in force. */
export async function filesDefining(root, name) {
  const head = await revision(root).catch(() => null);
  return (await readRuleFiles(root, head)).filter(({ path, text }) => parseQuestions(text, path, 'rule').some(rule => rule.name === name)).map(({ path }) => path);
}

/**
 * Which file a command works on. Named, it is that one, and a rule that lives somewhere else is an error rather than a second
 * copy. Unnamed, it is wherever the rule already is, and the root file for one that is nowhere yet.
 */
async function fileFor(root, name, file) {
  const defined = await filesDefining(root, name);
  if (file === undefined) return { file: defined.at(-1) ?? RULES_FILE, defined };
  const chosen = ruleFile(file);
  const elsewhere = defined.filter(path => path !== chosen);
  if (elsewhere.length) throw new Error(`${name} is a rule in ${elsewhere.join(' and ')}, not ${chosen}`);
  return { file: chosen, defined };
}

/** Add a rule, or refuse if that name is taken anywhere: two rules with one name is a report nobody can act on. */
export async function addRule(root, rule, { file } = {}) {
  const chosen = ruleFile(file ?? RULES_FILE);
  return withLock(root, chosen, async () => {
    const page = await open(root, chosen);
    const { doc, rules } = page;
    const defined = await filesDefining(root, rule.name);
    if (defined.length || named(rules, rule.name) >= 0)
      throw new Error(`${rule.name} is already a rule in ${defined[0] ?? chosen}; perch rules edit ${rule.name} changes it`);
    legible(rule, chosen);
    const node = doc.createNode({});
    for (const key of FIELDS) if (rule[key] !== undefined) node.set(key, write(doc, key, rule[key]));
    rules.items.push(node);
    await save(page);
    return rule;
  });
}

/**
 * Change what a question asks. Anything not named keeps what it had, so a wording fix does not mean restating the selector.
 *
 * A question perch ships is changed the same way: it is copied into your file as it was written, with the change applied, and
 * from then on yours is the one in force. Nothing is edited in place inside the package, so an upgrade still brings new questions
 * and you can see in one file everything this repository has decided to say differently.
 */
export async function editRule(root, name, changes, { file: inFile } = {}) {
  const { file } = await fileFor(root, name, inFile);
  return withLock(root, file, async () => {
    const page = await open(root, file);
    const { doc, rules, origin } = page;
    if (changes.name && changes.name !== name) {
      const taken = await filesDefining(root, changes.name);
      if (taken.length) throw new Error(`${changes.name} is already a rule in ${taken[0]}`);
    }
    let at = named(rules, name);
    if (at < 0) {
      const copy = shipped(name, origin);
      if (!copy) throw new Error(`no question called ${name}; perch rules list shows them`);
      rules.items.push(copy);
      at = rules.items.length - 1;
    }
    const node = rules.items[at];
    // Changing a question that was turned off is asking for it back, worded the new way.
    if (node.get('disabled') && changes.disabled === undefined) {
      node.delete('disabled');
      for (const pair of shipped(name, origin)?.items ?? []) {
        if (node.get(pair.key.value) !== undefined) continue;
        node.delete(pair.key.value);
        node.items.push(pair);
      }
    }
    // One assertion per rule: naming a different one replaces the one that was there rather than sitting beside it, and takes with
    // it anything the old one had been written out as. Writing it out longhand does the same to the shorthand.
    if (KINDS.some(key => changes[key] !== undefined)) for (const key of [...KINDS, ...EXPANDED]) node.delete(key);
    if (changes.ask !== undefined) for (const key of KINDS) node.delete(key);
    // null takes a key off, which is how a floor is removed rather than recorded as zero.
    for (const key of FIELDS) if (changes[key] === null) node.delete(key);
    for (const key of FIELDS) if (changes[key] !== undefined && changes[key] !== null) node.set(key, write(doc, key, changes[key]));
    legible(node.toJSON(), file);
    await save(page);
    return name;
  });
}

/**
 * Stop asking something. One of your own is taken out of the file; one perch ships cannot be, so it is turned off by name, which
 * is a line saying so rather than a silence you would have to know to look for. Either way the answer to "is this still asked" is
 * in this one file.
 */
export async function removeRule(root, name, { file: inFile } = {}) {
  const { file } = await fileFor(root, name, inFile);
  return withLock(root, file, async () => {
    const page = await open(root, file);
    const { doc, rules } = page;
    const at = named(rules, name);
    if (at < 0 && !BUILTIN.some(question => question.name === name)) throw new Error(`no question called ${name}; perch rules list shows them`);
    if (at < 0) rules.items.push(doc.createNode({ name, disabled: true }));
    else rules.items.splice(at, 1);
    await save(page);
    return { name, file, turnedOff: at < 0 };
  });
}
