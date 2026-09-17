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
import { questionMethod } from './hunt.js';
import { bodyOf, lintStep, matches, readLint, readRules } from './lint.js';
import { BELIEVED, filterKeys, huntSteps, issuesOf } from './questions.js';
import { openStore } from './store.js';

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
  const text = await readFile(join(root, path), 'utf8').catch(() => null);
  if (text === null) throw new Error(`${path} is not there`);
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
  return { rules: only.filter(name => !types.has(name)), types: only.filter(name => types.has(name)) };
}

/** The rules that have anything to say about this target: the ones whose selector covers it, narrowed by `only` when given. */
export function rulesFor(rules, unit, only = []) {
  return rules.filter(rule => {
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

  const asked = await Promise.all(rules.map(async rule => {
    const { state, question } = lintStep({ rule, unit, source: body });
    debug(`${rule.name}: ${unit.name}`);
    const { answers } = await systemOne.ask(state, question);
    return { rule: rule.name, said: rule.text, broken: readLint(rule, answers).broken };
  }));
  const broken = asked.filter(item => item.broken > BELIEVED).sort((a, b) => b.broken - a.broken);

  // The scan's questions need the method's callers and callees, which the last scan already knows; only the method itself is
  // re-read. Asked when nothing was named, or when what was named is a class the scan answers about.
  let issues = null;
  if (unit.part && (!only.length || named.types.length)) {
    const context = await methodContext({ finding: { method: `${unit.path}::${unit.name}`, path: unit.path, revision }, root, out, analyzer, revision, log: debug })
      .catch(() => null);
    if (context) {
      const node = { ...context.node, line: unit.line, end_line: unit.end_line, metrics: unit.metrics ?? context.node.metrics };
      const others = context.methods.filter(method => method.qualified_name !== unit.name);
      const steps = huntSteps({ node, lines: unit.lines, imports: context.imports, methods: [...others, node], callees: context.callees, callers: context.callers });
      const { answers } = await questionMethod({ systemOne, node, steps, lines: unit.lines, debug });
      issues = issuesOf({ ...answers, metrics: node.metrics });
      if (named.types.length) issues = issues.filter(issue => named.types.includes(issue.type));
    }
  }
  return { path: unit.path, name: unit.name, line: unit.line, checked: rules.length + (issues ? 1 : 0), broken, issues,
    clean: !broken.length && !(issues ?? []).length };
}
