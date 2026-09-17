/**
 * `perch check`: point at some code and ask the rules about it, as it reads on disk right now.
 *
 * This is the loop an agent runs — change something, ask whether it holds up — so it does the least that can answer that: parse
 * the one file, find the point named, and put the questions to it. No walk, no tree, nothing written down. A check is about
 * uncommitted work, and an answer about code that exists only in a working copy has no business in a log describing a commit.
 *
 * The target is a path, a path and a method, or an issue id, which resolves to whatever raised it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { languageOf } from './analysis.js';
import { methodContext } from './context.js';
import { questionMethod } from './scan.js';
import { bodyOf, matches, neighbourhood, readLint, readRules, RULES_FILE, unitStep } from './units.js';
import { BELIEVED, filterKeys, meaning, methodSteps, issuesOf } from './questions.js';
import { floorFor } from './ask.js';
import { openStore } from './store.js';

/** A check reads one file off disk, so there is no graph to draw a neighbourhood from: what `sees` can reach is that file. */
const EMPTY_GRAPH = { nodes: new Map() };

/** An 8-character hex id, as `perch issues` prints it, rather than a path. */
const looksLikeId = target => /^[0-9a-f]{4,8}$/.test(target);

/**
 * What to ask about: a file, or a method inside one. `src/cli.js::main` names a method, `src/cli.js` the whole file, and an issue
 * id names whatever the issue was about. A method is found by name in the file as it reads now, so it can have moved.
 */
export async function resolveTarget({ target, root, out, analyzer }) {
  let path = target, name = null;
  if (looksLikeId(target)) {
    const finding = await openStore(out).findFinding(target);
    path = finding.path;
    name = finding.name === finding.path ? null : finding.name;
  } else if (target.includes('::')) [path, name] = target.split('::');
  // Why it could not be read is the difference between a typo and a permission, so the reason comes with it.
  const text = await readFile(join(root, path), 'utf8')
    .catch(error => { throw new Error(error.code === 'ENOENT' ? `${path} is not there` : `${path} could not be read: ${error.message}`); });
  if (!name) return { path, name: path, line: 1, text, lines: text.split('\n') };
  const language = languageOf(path);
  if (!language) throw new Error(`${path} is not a language perch parses, so it has no methods to point at`);
  const analysis = await analyzer.analyzeSource(text, language);
  if (analysis.parser_status !== 'parsed') throw new Error(`${path} does not parse: ${analysis.parser_message ?? 'syntax error'}`);
  const found = analysis.declarations.find(declaration => declaration.qualified_name === name)
    ?? analysis.declarations.find(declaration => declaration.qualified_name.endsWith(`.${name}`));
  if (!found) throw new Error(`no method called ${name} in ${path}${analysis.declarations.length ? `; it has ${analysis.declarations.slice(0, 6).map(item => item.qualified_name).join(', ')}` : ''}`);
  return { path, name: found.qualified_name, line: found.line, end_line: found.end_line, metrics: found.metrics, part: true, text, lines: text.split('\n') };
}

/**
 * What `--rules` named, split into the two kinds of thing it can name: rules out of the rule file, and the classes the scan asks
 * about. Fixing a security hole is not a reason to hear about the method's comment, so `--rules security` asks the scan and
 * reports that class alone.
 */
export function splitOnly(only) {
  const types = new Set(filterKeys().type);
  const named = only.map(name => (types.has(meaning(name)) ? meaning(name) : name));
  return { rules: named.filter(name => !types.has(name)), types: named.filter(name => types.has(name)) };
}

/** The rules that have anything to say about this target: the ones whose selector covers it, narrowed by `only` when given. */
export function rulesFor(rules, unit, only = []) {
  return rules.filter(rule => {
    // A question written out longhand is asked of a method by a scan, not put to one file on its own.
    if (!rule.kind) return false;
    if (only.length && !only.includes(rule.name)) return false;
    if (!matches(String(rule.where).replace(/^(callers? of|mentions|writers? of) /, ''), unit.path)) return rule.where === unit.path;
    return Boolean(rule.each === 'method' || rule.each === 'test') === Boolean(unit.part);
  });
}

/**
 * Ask about one point in the code. Every rule that covers it, and, for a method, the scan's own questions as well, unless `only`
 * named the rules to ask. Asked together, since they do not depend on each other.
 */
export async function checkTarget({ target, root, out, analyzer, systemOne, revision, only = [], debug = () => {} }) {
  const unit = await resolveTarget({ target, root, out, analyzer });
  const named = splitOnly(only);
  // Naming only classes the scan answers about means the rule file was not named, so none of it is asked.
  const rules = only.length && !named.rules.length ? [] : rulesFor(await readRules(root, revision), unit, named.rules);
  const body = unit.part ? bodyOf(unit.text, unit) : unit.text;

  // Every rule that covers this point, asked over it at once. A rule that wants more than the unit itself is its own context.
  const contexts = new Map();
  for (const rule of rules) {
    if (!contexts.has(rule.sees)) contexts.set(rule.sees, []);
    contexts.get(rule.sees).push(rule);
  }
  const asked = (await Promise.all([...contexts].map(async ([sees, together]) => {
    const { state, questions } = unitStep({ rules: together, unit, source: body, seen: neighbourhood(sees, unit, { graph: EMPTY_GRAPH, files: new Map([[unit.path, unit.text]]) }) });
    debug(`${together.map(rule => rule.name).join(', ')}: ${unit.name}`);
    const { answers } = await systemOne.ask(state, questions);
    return together.map(rule => ({ rule: rule.name, said: rule.text, broken: readLint(rule, answers).broken, floor: floorFor(rule, BELIEVED) }));
  }))).flat();
  // Each rule's own floor, the same one a scan reads it by. A flat 50% here called a rule broken that a scan would not list, so
  // fixing what check said was wrong left the run still green and fixing what the run said left check still red.
  const broken = asked.filter(item => item.broken > item.floor).sort((a, b) => b.broken - a.broken);

  // The scan's questions need the method's callers and callees, which the last scan already knows; only the method itself is
  // re-read. Asked when nothing was named, or when what was named is a class the scan answers about.
  let issues = null, note = null;
  if (unit.part && (!only.length || named.types.length)) {
    const context = await methodContext({ finding: { method: `${unit.path}::${unit.name}`, path: unit.path, revision }, root, out, analyzer, revision, log: debug })
      .catch(error => { note = error.message; return null; });
    // The scan's questions are asked over a neighbourhood the last scan worked out, so a file it has never read has none. Saying
    // nothing here reads as a clean bill of health for a method nothing was asked about, which is the opposite of the truth.
    if (!context && named.types.length) throw new Error(`no neighbourhood for ${unit.path}: ${note}. Run perch scan first, or name a rule from ${RULES_FILE} instead`);
    if (context) {
      const node = { ...context.node, line: unit.line, end_line: unit.end_line, metrics: unit.metrics ?? context.node.metrics };
      const others = context.methods.filter(method => method.qualified_name !== unit.name);
      const steps = methodSteps({ node, lines: unit.lines, imports: context.imports, methods: [...others, node], callees: context.callees, callers: context.callers });
      const { answers } = await questionMethod({ systemOne, node, steps, lines: unit.lines, debug });
      issues = issuesOf({ ...answers, metrics: node.metrics });
      if (named.types.length) issues = issues.filter(issue => named.types.includes(issue.type));
    }
  }
  return { path: unit.path, name: unit.name, line: unit.line, checked: rules.length + (issues ? 1 : 0), broken, issues, note,
    clean: !broken.length && !(issues ?? []).length };
}
