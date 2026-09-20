/**
 * Editing `perch.yaml` from the command line. The file is yours to write by hand and always will be, but adding a rule mid-thought
 * should not mean stopping to find the file, and an agent that spots a pattern worth a rule has no business rewriting YAML by
 * string surgery. Comments and the order of what is already there survive every edit.
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseDocument, Scalar } from 'yaml';
import { BUILTIN, check, ENSURES, SHAPES, parseQuestions } from './ask.js';
import { RULES_FILE, readRuleFiles } from './units.js';

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
async function open(root) {
  const path = join(root, RULES_FILE);
  const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const doc = parseDocument(text);
  if (!doc.contents || !doc.contents.items) doc.contents = doc.createNode([]);
  // The text it was parsed from goes back with it, because the write puts the whole document down again and has to know it is
  // putting it down over the one it picked up.
  return { path, doc, rules: rulesOf(doc), text };
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
async function withLock(path, work) {
  const lock = `${path}.lock`;
  for (let tries = 0; ; tries++) {
    try { await writeFile(lock, `${process.pid}\n`, { flag: 'wx' }); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (tries >= 50) throw new Error(`${RULES_FILE} is being edited by another perch. If none is running, delete ${RULES_FILE}.lock`, { cause: error });
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
async function save(path, doc, was) {
  const now = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  if (now !== was) throw new Error(`${RULES_FILE} changed while perch was editing it, so nothing was written. Run that again.`);
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, String(doc));
  await rename(tmp, path);
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
const legible = rule => check(Object.fromEntries(Object.entries(rule).filter(([, value]) => value !== undefined)), RULES_FILE, 'rule');

/** A root-file edit cannot change a definition supplied by a later split file. */
async function editableAtRoot(root, name) {
  for (const { path, text } of await readRuleFiles(root, 'HEAD')) {
    if (path !== RULES_FILE && parseQuestions(text, path, 'rule').some(rule => rule.name === name))
      throw new Error(`${name} is already a rule in ${path}; edit that file directly`);
  }
}

/** Add a rule, or refuse if that name is taken: two rules with one name is a report nobody can act on. */
export async function addRule(root, rule) {
  return withLock(join(root, RULES_FILE), async () => {
    const { path, doc, rules, text } = await open(root);
    await editableAtRoot(root, rule.name);
    if (named(rules, rule.name) >= 0) throw new Error(`${rule.name} is already a rule; perch rules edit ${rule.name} changes it`);
    legible(rule);
    const node = doc.createNode({});
    for (const key of FIELDS) if (rule[key] !== undefined) node.set(key, write(doc, key, rule[key]));
    rules.items.push(node);
    await save(path, doc, text);
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
export async function editRule(root, name, changes) {
  return withLock(join(root, RULES_FILE), async () => {
    const { path, doc, rules, text } = await open(root);
    await editableAtRoot(root, name);
    if (changes.name && changes.name !== name) await editableAtRoot(root, changes.name);
    let at = named(rules, name);
    if (at < 0) {
      const shipped = BUILTIN.find(question => question.name === name);
      if (!shipped) throw new Error(`no question called ${name}; perch rules list shows them`);
      rules.items.push(doc.createNode(shipped.declared));
      at = rules.items.length - 1;
    }
    const node = rules.items[at];
    // Changing a question that was turned off is asking for it back, worded the new way.
    if (node.get('disabled') && changes.disabled === undefined) {
      node.delete('disabled');
      const shipped = BUILTIN.find(question => question.name === name);
      if (shipped) for (const [key, value] of Object.entries(shipped.declared)) if (key !== 'name' && node.get(key) === undefined) node.set(key, write(doc, key, value));
    }
    // One assertion per rule: naming a different one replaces the one that was there rather than sitting beside it, and takes with
    // it anything the old one had been written out as. Writing it out longhand does the same to the shorthand.
    if (KINDS.some(key => changes[key] !== undefined)) for (const key of [...KINDS, ...EXPANDED]) node.delete(key);
    if (changes.ask !== undefined) for (const key of KINDS) node.delete(key);
    // null takes a key off, which is how a floor is removed rather than recorded as zero.
    for (const key of FIELDS) if (changes[key] === null) node.delete(key);
    for (const key of FIELDS) if (changes[key] !== undefined && changes[key] !== null) node.set(key, write(doc, key, changes[key]));
    legible(node.toJSON());
    await save(path, doc, text);
    return name;
  });
}

/**
 * Stop asking something. One of your own is taken out of the file; one perch ships cannot be, so it is turned off by name, which
 * is a line saying so rather than a silence you would have to know to look for. Either way the answer to "is this still asked" is
 * in this one file.
 */
export async function removeRule(root, name) {
  return withLock(join(root, RULES_FILE), async () => {
    const { path, doc, rules, text } = await open(root);
    await editableAtRoot(root, name);
    const at = named(rules, name);
    const shipped = BUILTIN.find(question => question.name === name);
    if (at < 0 && !shipped) throw new Error(`no question called ${name}; perch rules list shows them`);
    if (at < 0) rules.items.push(doc.createNode({ name, disabled: true }));
    else rules.items.splice(at, 1);
    await save(path, doc, text);
    return { name, turnedOff: at < 0 };
  });
}
