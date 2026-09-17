/**
 * Editing `perch.yaml` from the command line. The file is yours to write by hand and always will be, but adding a rule mid-thought
 * should not mean stopping to find the file, and an agent that spots a pattern worth a rule has no business rewriting YAML by
 * string surgery. Comments and the order of what is already there survive every edit.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument, Scalar } from 'yaml';
import { BUILTIN, check, ENSURES, SHAPES } from './ask.js';
import { RULES_FILE } from './units.js';

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
  return { path, doc };
}

const named = (doc, name) => doc.contents.items.findIndex(item => item.get?.('name') === name);

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

/** Add a rule, or refuse if that name is taken: two rules with one name is a report nobody can act on. */
export async function addRule(root, rule) {
  const { path, doc } = await open(root);
  if (named(doc, rule.name) >= 0) throw new Error(`${rule.name} is already a rule; perch rules edit ${rule.name} changes it`);
  legible(rule);
  const node = doc.createNode({});
  for (const key of FIELDS) if (rule[key] !== undefined) node.set(key, write(doc, key, rule[key]));
  doc.contents.items.push(node);
  await writeFile(path, String(doc));
  return rule;
}

/**
 * Change what a question asks. Anything not named keeps what it had, so a wording fix does not mean restating the selector.
 *
 * A question perch ships is changed the same way: it is copied into your file as it was written, with the change applied, and
 * from then on yours is the one in force. Nothing is edited in place inside the package, so an upgrade still brings new questions
 * and you can see in one file everything this repository has decided to say differently.
 */
export async function editRule(root, name, changes) {
  const { path, doc } = await open(root);
  let at = named(doc, name);
  if (at < 0) {
    const shipped = BUILTIN.find(question => question.name === name);
    if (!shipped) throw new Error(`no question called ${name}; perch rules list shows them`);
    doc.contents.items.push(doc.createNode(shipped.declared));
    at = doc.contents.items.length - 1;
  }
  const node = doc.contents.items[at];
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
  await writeFile(path, String(doc));
  return name;
}

/**
 * Stop asking something. One of your own is taken out of the file; one perch ships cannot be, so it is turned off by name, which
 * is a line saying so rather than a silence you would have to know to look for. Either way the answer to "is this still asked" is
 * in this one file.
 */
export async function removeRule(root, name) {
  const { path, doc } = await open(root);
  const at = named(doc, name);
  const shipped = BUILTIN.find(question => question.name === name);
  if (at < 0 && !shipped) throw new Error(`no question called ${name}; perch rules list shows them`);
  if (at < 0) doc.contents.items.push(doc.createNode({ name, disabled: true }));
  else doc.contents.items.splice(at, 1);
  await writeFile(path, String(doc));
  return { name, turnedOff: at < 0 };
}
