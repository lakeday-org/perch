/** perch command line: scan, issues, check, close, rules, doctor. */
import { join } from 'node:path';
import { repoRoot, revision as gitRevision } from './git.js';
import { resolveTarget } from './target.js';
import { createSystemOne } from './systemone.js';
import { createSourceAnalyzer } from './analysis.js';
import { openStore, resolveOut } from './store.js';
import { analyzeTree } from './analyze.js';
import { covers, DEFAULT_PARALLEL, scanRepository } from './scan.js';
import { BELIEVED, filterKeys, filterStrength, matchesFilters, parseFilters } from './questions.js';
import { splitStale } from './context.js';
import { changedPaths, readRuleFiles, readRules, RULES_FILE, RULES_DIR, UNIT_PARALLEL } from './units.js';
import { checkTarget } from './check.js';
import { runChecks } from './checks.js';
import { addRule, editRule, KINDS as RULE_KINDS, removeRule, ruleFile } from './rules.js';
import { allQuestions, parseQuestions, SHAPES } from './ask.js';
import { installSkill, TARGET_NAMES, TARGETS } from './setup.js';
import { createMeter, metered } from './meter.js';
import { formatDoctor, formatFilterKeys, gating, useColor, formatFinding, formatIssues, formatCheck, formatRules, formatScanReport, issueCount, scanCount, scanTally, TOP, visibleFindings } from './report.js';

/**
 * Stamped into the bundle at build time, so it reports what is running rather than a number read off a package.json that may not
 * be the one this code came from. A build that is not sitting on its release tag says DEVELOPMENT and names the commit.
 */
export const VERSION = typeof PERCH_VERSION === 'string' ? PERCH_VERSION : 'dev';

const options = {
  paths: ['--paths a,b', 'Only consider files under these repository paths', ['scan']],
  parallel: ['--parallel N', `How many methods to read at once (default ${DEFAULT_PARALLEL}; files and tests go ${UNIT_PARALLEL} at a time)`, ['scan']],
  since: ['--since REF', 'Only what changed since this branch or commit', ['scan']],
  all: ['--all', 'List every row instead of the top 10', ['scan', 'issues']],
  limit: ['--limit N', `Rows per page (default ${TOP})`, ['issues']],
  page: ['--page N', 'Which page of them, 1 is the first', ['issues']],
  closed: ['--closed', 'Include closed issues (worked and given up on, or nothing left to do)', ['issues']],
  min: ['--min P', `Only issues it is at least P percent sure of (default ${BELIEVED * 100}; --min 0 shows everything). On a rule, the floor for that one alone`, ['scan', 'issues', 'rules']],
  filter: ['--filter k=v', 'Only issues matching, e.g. type=security, kind=too big, severity=P1 (comma-separated)', ['scan', 'issues']],
  gate: ['--gate yes|no', 'Whether breaking this one fails a scan. Defaults to yes for a defect, a vulnerability or a rule', ['rules']],
  file: ['--file F', `The rule file: ${RULES_FILE} or a .yaml under ${RULES_DIR}/. add creates it; list shows only it`, ['rules']],
  types: ['--types', 'Print everything --filter accepts and stop', ['issues']],
  rules: ['--rules a,b', 'Ask only these: rule names, or defect, security, refactor, docs', ['check']],
  ensure: ['--ensure TEXT', 'What has to be true of every file or method it covers', ['rules']],
  ensure_present: ['--ensure_present TEXT', 'Something that has to be somewhere in what it covers', ['rules']],
  ensure_absent: ['--ensure_absent TEXT', 'Something that must not be anywhere in what it covers', ['rules']],
  where: ['--where W', 'What it covers: a glob, callers of <method>, or mentions <text>', ['rules']],
  except: ['--except W', 'A glob it spares', ['rules']],
  each: ['--each U', 'Ask about each file, method, or test rather than the file as a whole', ['rules']],
  sees: ['--sees S', 'What a file or test is shown besides itself: file, calls, callers, or neighbors', ['rules']],
  type: ['--type T', `The shape of the answer: ${SHAPES.join(', ')} (default noul)`, ['rules']],
  ask: ['--ask TEXT', 'The question itself, in place of --ensure', ['rules']],
  true: ['--true TEXT', 'What a yes means, for --type noul', ['rules']],
  false: ['--false TEXT', 'What a no means, for --type noul', ['rules']],
  options: ['--options "a=..; b=.."', 'The options and what each means, for --type choice', ['rules']],
  levels: ['--levels "a; b; c"', 'The rubric, weakest first, for --type score', ['rules']],
  when: ['--when NAME', 'Another question this one is only as likely as; the two multiply', ['rules']],
  issue: ['--issue "type=..,label=.."', 'What an answer means: type, label, on, pick, except', ['rules']],
  reason: ['--reason R', 'Why you are setting these aside, kept on the record', ['close']],
  kind: ['--kind a,b', 'Only these kinds of it, e.g. docs, too_big (default: everything on it now)', ['close', 'reopen']],
  force: ['--force', 'Replace a skill file you have already edited', ['setup']],
  out: ['--out DIR', 'Results directory (default .perch)', ['scan', 'issues', 'check', 'close', 'reopen', 'doctor']],
  json: ['--json', 'Print JSON instead of a summary', ['scan', 'rules', 'issues', 'check', 'close', 'reopen', 'doctor', 'setup']],
  verbose: ['--verbose', 'Show every file, method, model call, and command', ['scan', 'issues', 'check']],
};

/** Other names that still work. */
const ALIASES = { findings: 'issues' };

const commandHelp = {
  scan: { args: '[target]', summary: 'Find issues', detail: `Scores every method with tree-sitter, then reads them with System One, callers and callees in view. Custom rules in ${RULES_FILE} and ${RULES_DIR}/ are asked in the same reading, so they cost nothing extra on a method perch was reading anyway.\n\nA method is reused when its code, neighbours, questions, endpoint and model are unchanged since the last run. The answer would be the same one, and asking for it would move the numbers on an issue you have already looked at. Delete .perch/scan.jsonl to ask about everything again.\n\ntarget is the file or directory to read, and defaults to where you are. --paths and --since narrow it further, and --since origin/main is what CI wants. Exits 3 on anything it found. Every type it asks about fails the run; scan_types in perch.yaml decides which those are, and defaults to defect, security and lint. Needs PERCH_API_KEY. PERCH_BASE_URL sets the exact request URL; PERCH_MODEL_ID selects the model.` },
  rules: { args: '[list | add <name> | edit <name> | remove <name>]', summary: `Change ${RULES_FILE} without opening it`, detail: `Custom rules are questions perch asks alongside its own, written in the same grammar as the ones it ships with in scan.yaml. perch scan asks them; this writes them, keeping comments and ordering.\n\nRules live in ${RULES_FILE} or in .yaml files under ${RULES_DIR}/. add writes to ${RULES_FILE} unless --file names a split file; edit and remove find the file a rule is in; list shows every file, or one file with --file.\n\nMost are a yes-or-no, so --ensure is usually the only flag needed. It covers what a parser can't: whether a comment says why, whether a test asserts what you claim.\n\n  perch rules add no-stale-docs --where "docs/**/*.md" --ensure_absent "docs for code that was deleted"\n\nAn answer that is not yes-or-no is written out: --ask with --type and the options or levels it offers, and --issue for what an answer means. --when names a question this one is only as likely as.\n\n  perch rules add handles_absence --type choice --each method --where "src/**/*.js" \\\n    --ask "How does this method handle a value that is missing?" \\\n    --options "checks=It checks for it; ignores=It carries on with the missing value" \\\n    --issue "type=defect,label=handles_absence,except=checks"` },
  issues: { args: '[issue-id]', summary: 'List what the scan found, or show one', detail: 'Worst first. --filter narrows the list, --types prints what it accepts, --closed includes closed ones, --all lists every row. Give it an id to see everything known about that method. perch findings does the same thing.' },
  check: { args: '<path | path::method | issue-id>', summary: 'Ask about one piece of code, uncommitted', detail: 'Reads that one file off disk and asks about the point you named: every rule that covers it, plus the scan\'s own questions for a method. --rules narrows it to specific rules, or to defect, security, refactor or docs. Nothing is committed or recorded, so run it on work in progress. Exits 3 while something is still wrong. Needs PERCH_API_KEY. PERCH_BASE_URL sets the exact request URL; PERCH_MODEL_ID selects the model.' },
  close: { args: '<issue-id>...', summary: 'Set issues aside', detail: 'Stops an issue being listed: a false positive, or code you have looked at and are not changing. --reason is kept and shown by perch issues <id>. It stays closed through later scans and later edits, and perch reopen is the only thing that brings it back.\n\nIt covers the kinds on that issue now, so a defect found in the method later is a new thing and is listed. --kind closes some of them and leaves the rest:\n\n  perch close 2638fb16 --kind docs' },
  reopen: { args: '<issue-id>...', summary: 'Put closed issues back', detail: 'Undoes perch close, all of it, or the kinds --kind names.' },
  setup: { args: `<${TARGET_NAMES.join(' | ')}>`, summary: 'Teach a coding assistant to use perch', detail: `Writes the perch skill into the assistant's configuration, so it knows to scan what a branch changed, to read the JSON rather than the table, that a finding is a probability rather than a located defect, to ask about one method after a fix, and to write a rule when the same mistake comes back.\n\n${Object.entries(TARGETS).map(([name, target]) => `  perch setup ${name}`.padEnd(28) + target.path).join('\n')}\n\nThe file can be edited once written: perch will not replace an edited one unless you pass --force.` },
  doctor: { args: '', summary: 'Check perch can run, and what the last run did', detail: 'Whether perch can run here: node, the API key, git, the repository, somewhere to write, and whether perch.yaml parses. Anything that fails says what to do about it, and the command exits 1, since perch cannot run here.\n\nUnder that, the last run: every method it could not read with the error, every question it asked and what each raised, and the end of the log when a run did not finish. Names, paths, counts and error messages only, never source, so it can be pasted into a bug report as it stands.' },
};

/** Help at 80 columns. A blank line stays a blank line, and an indented line is an example, left exactly as written. */
const wrap = text => String(text).split(/\n\s*\n/).map(paragraph => paragraph.startsWith(' ') ? paragraph : paragraph.split(/\s+/).filter(Boolean).reduce((lines, word) => {
  if (lines.length && (lines.at(-1) + ' ' + word).length <= 80) lines[lines.length - 1] += ' ' + word;
  else lines.push(word);
  return lines;
}, []).join('\n')).join('\n\n');

const column = (rows, indent = '  ') => {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}`).join('\n');
};

const usage = `Usage: perch <command> [options]

Commands:
${column(Object.entries(commandHelp).map(([name, help]) => [`${name} ${help.args}`.trim(), help.summary]))}

Options:
${column([...Object.values(options).filter(([, , verbs]) => verbs.length === Object.keys(commandHelp).length).map(([flag, text]) => [flag, text]), ['-h, --help', 'This help; perch <command> --help for one command'], ['-v, --version', 'The release this was built from, or DEVELOPMENT and the commit']])}

Environment:
${column([['PERCH_API_KEY', 'scan, check'], ['PERCH_BASE_URL', 'scan, check: exact request URL (default https://api.typesafe.ai/v1/systemone)'], ['PERCH_MODEL_ID', 'scan, check: model ID (default jev-latest)']])}`;

function usageFor(name) {
  const help = commandHelp[name];
  const own = Object.values(options).filter(([, , verbs]) => verbs.includes(name));
  return `perch ${name}: ${help.summary}

Usage: perch ${name} ${help.args ? `${help.args} ` : ''}[options]

${wrap(help.detail)}

Options:
${column(own.map(([flag, text]) => [flag, text]))}`;
}

/**
 * What perch comes back with. A run that found something and a run that fell over are different things and used to be the same
 * number, so anything reading the code could not tell a report from a crash.
 */
export const EXIT = { clean: 0, broke: 1, usage: 2, found: 3 };

const valued = new Set(['paths', 'parallel', 'min', 'filter', 'out', 'reason', 'kind', 'limit', 'page', 'since', 'rules',
  'ensure', 'ensure_present', 'ensure_absent', 'where', 'except', 'each', 'sees', 'type', 'ask', 'true', 'false', 'options', 'levels', 'when', 'issue', 'gate', 'file']);
const switches = new Set(['force', 'all', 'json', 'verbose', 'closed', 'types', 'help', 'version']);

export function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (arg === '-h') { flags.help = true; continue; }
    if (arg === '-v') { flags.version = true; continue; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    if (valued.has(key)) {
      // `--min=` is as empty as `--min` with nothing after it, and an empty string reads as zero further down, which would make
      // it a floor of none rather than a mistake to correct.
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '') throw new Error(`--${key} requires a value`);
      flags[key] = value;
    } else if (switches.has(key)) flags[key] = true;
    else throw new Error(`unknown option --${key}`);
  }
  return { flags, positional };
}

class UsageError extends Error {}

/** A flag the command does not take is a mistake, not something to ignore: the parser accepts every flag, so this is where they are checked. */
function checkFlags(flags, commandName) {
  for (const key of Object.keys(flags)) {
    if (key === 'help') continue;
    const verbs = options[key]?.[2];
    if (!verbs?.includes(commandName)) throw new UsageError(`perch ${commandName} does not take --${key}${verbs ? `; it belongs to ${verbs.join(', ')}` : ''}`);
  }
}

const parsePaths = flags => flags.paths ? flags.paths.split(',').map(path => path.trim()).filter(Boolean) : [];
const storeFrom = async flags => openStore(await resolveOut(flags.out));
/**
 * Put this repository's own questions in force. Anything that names a kind, or reads one back off a finding, has to know what
 * this repository can raise: perch's list plus whatever perch.yaml reworded or added. Called before a filter is read rather than
 * after, or a filter would refuse a value the same command prints.
 */
const ownQuestions = async () => {
  const root = await repoRoot(process.cwd()).catch(() => null);
  if (root) await readRules(root, await gitRevision(root));
  return root;
};
/** `--filter type=security,severity=P1` as tests a finding must pass; a bad clause is a usage error naming the real values. */
const filtersFrom = (flags, rules = []) => { try { return parseFilters(flags.filter ?? '', rules); } catch (error) { throw new UsageError(error.message); } };
/** The rules in force, so `--filter rule=` can name one and a typo is answered with the list. */
const rulesInForce = async root => readRules(root, await gitRevision(root)).catch(() => []);
/** The findings a filter keeps, the surest match first: filtering for one kind of problem should rank by that problem, not by whatever else the method carries. With no filter the scan's own ranking stands. */
const narrow = (findings, filters, min) => findings.filter(finding => matchesFilters(finding, filters, min))
  .sort((a, b) => filters.length ? filterStrength(b, filters) - filterStrength(a, filters) : 0);
const threshold = (value, fallback = BELIEVED * 100) => { const min = value === undefined ? fallback : Number(value); if (!(min >= 0 && min <= 100)) throw new UsageError('--min must be a percentage, 0 to 100: how sure the scan has to be of an issue to list it'); return min; };
const positiveInteger = (flag, value, fallback) => { const number = value === undefined ? fallback : Number(value); if (!Number.isInteger(number) || number < 1) throw new UsageError(`${flag} must be a positive integer`); return number; };
const print = (io, record, text) => io.stdout(io.flags.json ? JSON.stringify(record, null, 2) : text);
/** Counts and costs: context for a person watching, never part of the output a pipe reads. */
const noteFrom = (io, stderr) => (...lines) => { if (!io.flags.json) for (const line of lines.filter(Boolean)) stderr(line); };
/**
 * How many rows to print. The top ten is what an unasked-for list is cut to, because nobody wants 365 rows for typing `perch
 * issues`. A filter is the asking: you named what you wanted, so you get all of it. --limit and --page say it outright.
 */
const shown = (io, filters = []) => (io.flags.all || filters.length ? Infinity : TOP);
/** --page without --limit still needs a page size, so it falls back to the ten an unasked-for list is cut to. */
function paging(io, filters = []) {
  const limit = io.flags.limit === undefined ? null : positiveInteger('--limit', io.flags.limit);
  const page = io.flags.page === undefined ? null : positiveInteger('--page', io.flags.page);
  if (io.flags.all && !limit && !page) return { from: 0, size: Infinity };
  const size = limit ?? (page ? TOP : shown(io, filters));
  return { from: page ? (page - 1) * size : 0, size };
}
/** A turning thing, so a run that is waiting on something looks like it is waiting rather than like it has died. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** One line, one spinner: the phases run in turn, so the counter that wrote last is the one the frame belongs to. */
let onTheLine = null, turning = null, frame = 0;

/**
 * An in-place counter on stderr for interactive runs; silent when piped, verbose, or JSON. It says what is happening now, and it
 * says it in methods from the first line to the last, since that is the thing a run gets through. A phase that does not yet know
 * how many there are counts up without a total rather than borrowing one from something else.
 *
 * The number only moves when an answer arrives, and an answer can be a long time coming: a slow method, a service retrying, a
 * whole batch in flight. The spinner keeps turning through all of it, which is the difference between waiting and hung.
 */
function liveCounter(io, doing) {
  const live = process.stderr.isTTY && !io.verbose && !io.flags.json;
  // Every redraw turns it, whether the redraw came from an answer arriving or from the clock. Work that holds the loop shows as
  // movement when the count moves; work that holds nothing shows as movement from the clock.
  const draw = () => { if (onTheLine) process.stderr.write(`\r\x1b[K${SPINNER[frame++ % SPINNER.length]} ${onTheLine}`); };
  const write = text => {
    if (!live) return;
    onTheLine = text;
    // Unreferenced, so a run that is otherwise finished is never held open by the thing that says it is not.
    if (!turning) { turning = setInterval(draw, 80); turning.unref?.(); }
    draw();
  };
  const stop = () => {
    if (!live) return;
    if (turning) { clearInterval(turning); turning = null; }
    onTheLine = null;
    process.stderr.write('\r\x1b[K');
  };
  return { update: (done, total) => write(total ? `${doing} ${done} of ${total}` : `${doing} ${done}`), say: text => write(text), clear: stop };
}

/** The open issues at HEAD: findings for methods that no longer exist are dropped and counted. */
async function openIssues(store, min, io) {
  const root = (await store.latestRun())?.root ?? (await store.latestScan())?.root ?? null;
  // Parsing the tree is what says which findings are about code that still exists. Swallowing a failure here listed everything
  // the last scan found as though it were all still there, which is a wrong list rather than a missing one.
  const scan = root ? await analyzeTree({ root, revision: await gitRevision(root), out: store.out, analyzer: createSourceAnalyzer(), log: io.debug, debug: io.debug }) : null;
  let findings = await store.issues(min / 100, { scan }), gone = 0;
  if (scan) { const { current, stale } = splitStale(findings, scan); findings = current; gone = stale.length; }
  // A method edited since the scan read it keeps none of its answers: they are about code that is not there any more. Counted
  // against the tree rather than against the list, since a finding with nothing left on it never reaches the list.
  const { latest } = await store.indexes();
  let edited = 0;
  for (const file of scan?.files ?? []) for (const method of file.methods) {
    const reading = latest.get(method.id);
    if (reading && reading.hash !== method.hash) edited++;
  }
  return { findings, gone, edited, root, scan };
}

/** `--kind docs,too_big` as the labels a closure covers. A name nothing can be listed under closes nothing, so it is a mistake. */
function kindsFrom(flags) {
  if (flags.kind === undefined) return null;
  const allowed = filterKeys().kind;
  const named = String(flags.kind).split(',').map(part => part.trim()).filter(Boolean);
  if (!named.length) throw new UsageError(`--kind needs at least one of ${allowed.join(', ')}`);
  const wrong = named.filter(name => !allowed.includes(name));
  if (wrong.length) throw new UsageError(`${wrong.join(', ')} is not a kind; perch issues --types lists them`);
  return named;
}

/** `perch close a1b2 c3d4 --reason "..."`, and its undo. Ids are the ones in the first column; a unique prefix is enough. */
async function setAside(io, verb) {
  if (!io.args.length) throw new UsageError(`perch ${verb} needs at least one issue id; perch issues lists them`);
  await ownQuestions();
  const store = await storeFrom(io.flags);
  const kinds = kindsFrom(io.flags);
  const done = [];
  for (const ref of io.args) {
    const finding = await store.findFinding(ref);
    done.push(verb === 'close' ? await store.dismiss(finding, io.flags.reason ?? null, kinds) : await store.reopen(finding, kinds));
  }
  print(io, done, done.map(event => `${event.id}  ${event.name}  ${event.path}:${event.line ?? ''}`.trimEnd()
    + `  ${verb === 'close' ? 'closed' : 'reopened'}${event.kinds?.length ? `  ${event.kinds.join(', ')}` : ''}`).join('\n'));
}

/** What a scan covers: --paths as given, or what --since says a branch changed. */
// A scan covers the target it was given, narrowed further by --paths or --since. `perch scan docs/` is `--paths docs`, so a
// directory costs what it covers rather than what encloses it.
const scanPaths = async (io, root, scope = null) => {
  const asked = io.flags.since ? await changedPaths(root, io.flags.since) : parsePaths(io.flags);
  if (!scope) return asked;
  if (!asked.length) return [scope];
  // Both were given, so the run is what they agree on: the asked-for paths that lie inside the target.
  return asked.filter(path => path === scope || path.startsWith(scope.replace(/\/$/, '') + '/'));
};

/** `--options "a=An a; b=A b"` as the map it is written as in the file. Semicolons, since a description often has a comma in it. */
function pairsFrom(flag, text) {
  const pairs = String(text).split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const at = part.indexOf('=');
    if (at < 1) throw new UsageError(`${flag} is written "name=what it means", separated by semicolons; "${part}" is not`);
    return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
  });
  if (!pairs.length) throw new UsageError(`${flag} needs at least one`);
  return Object.fromEntries(pairs);
}

/** `--issue "type=defect,label=kind,on=false"`. No description in it, so commas separate and the values are words. */
function issueFrom(text) {
  const issue = {};
  for (const [key, value] of Object.entries(pairsFrom('--issue', String(text).replace(/,/g, ';')))) {
    issue[key] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return issue;
}

/** What the flags say the question is, in the grammar's own words. */
/** A flag a person types as yes, true or on, since a question is being answered rather than a variable set. */
function yesOrNo(flag, value) {
  const said = String(value).toLowerCase();
  if (['yes', 'true', 'on', '1'].includes(said)) return true;
  if (['no', 'false', 'off', '0'].includes(said)) return false;
  throw new UsageError(`${flag} is yes or no, not ${value}`);
}

function ruleFrom(flags) {
  const written = Object.fromEntries(['type', 'where', 'except', 'each', 'sees', 'when', 'ask', 'true', 'false', ...RULE_KINDS]
    .filter(key => flags[key] !== undefined).map(key => [key, flags[key]]));
  // A floor of zero is no floor, so it comes off the rule rather than sitting there as a number that does nothing.
  if (flags.min !== undefined) { const min = threshold(flags.min); written.min = min === 0 ? null : min; }
  if (flags.gate !== undefined) written.gate = yesOrNo('--gate', flags.gate);
  if (flags.options !== undefined) written.options = pairsFrom('--options', flags.options);
  if (flags.levels !== undefined) written.levels = String(flags.levels).split(';').map(part => part.trim()).filter(Boolean);
  if (flags.issue !== undefined) written.issue = issueFrom(flags.issue);
  return written;
}

/** The questions perch asks, as something you can change without opening the file. */
async function manageRules(io, action, name) {
  const root = await repoRoot(process.cwd());
  const written = ruleFrom(io.flags);
  if (action === 'list') {
    // Everything in force, not just what this repository added: a question perch ships is asked of your code the same way, and
    // it is editable the same way, so leaving it off the list would be hiding half of what a scan does.
    const head = await gitRevision(root);
    await readRules(root, head);
    // Which file each rule is in, the last definition winning the way a scan reads them. --file lists that one file alone.
    const own = new Map();
    for (const { path, text } of await readRuleFiles(root, head)) for (const rule of parseQuestions(text, path, 'rule')) own.set(rule.name, path);
    const only = io.flags.file === undefined ? null : ruleFile(io.flags.file);
    const all = [...allQuestions()].filter(rule => !only || own.get(rule.name) === only).sort((a, b) => Number(own.has(b.name)) - Number(own.has(a.name)));
    print(io, all.map(rule => ({ name: rule.name, from: own.get(rule.name) ?? 'perch', disabled: Boolean(rule.disabled),
      type: rule.type, kind: rule.kind, where: rule.where, each: rule.each, sees: rule.sees, except: rule.except ?? null,
      when: rule.when ?? null, text: rule.text ?? rule.ask })), formatRules(all, { own }));
    return EXIT.clean;
  }
  if (!name) throw new UsageError(`perch rules ${action} needs a name`);
  const file = io.flags.file;
  if (action === 'remove') {
    const { turnedOff, file: from } = await removeRule(root, name, { file });
    io.stdout(turnedOff ? `Turned off ${name}, which perch ships. perch rules edit ${name} turns it back on.` : `Removed ${name} from ${from}.`);
    return EXIT.clean;
  }
  if (RULE_KINDS.filter(key => written[key]).length > 1) throw new UsageError('a rule asks one thing: give one of --ensure, --ensure_present, --ensure_absent');
  if (written.ask && RULE_KINDS.some(key => written[key])) throw new UsageError('--ask writes the question out; --ensure is the short way of writing one, so give one or the other');
  if (!Object.keys(written).length) throw new UsageError(`perch rules ${action} needs something to write: --ensure, or --ask with --type`);
  if (action === 'add') {
    if (!RULE_KINDS.some(key => written[key]) && !written.ask) throw new UsageError(`perch rules add needs --ensure, --ensure_present, --ensure_absent, or --ask`);
    // Everything, unless you say otherwise. A rule that covers the whole repository is a fine rule to want.
    await addRule(root, { name, where: '**/*', ...written }, { file });
    io.stdout(`Added ${name} to ${file === undefined ? RULES_FILE : ruleFile(file)}.`);
    return EXIT.clean;
  }
  await editRule(root, name, written, { file });
  io.stdout(`Changed ${name}.`);
  return EXIT.clean;
}

const commands = {
  async scan(io) {
    const meter = createMeter();
    const parallel = positiveInteger('--parallel', io.flags.parallel, DEFAULT_PARALLEL);
    const min = threshold(io.flags.min) / 100;
    // The target comes first: a filter can name a rule, and the rules are read from the repository the target resolves to.
    const resolved = await resolveTarget(io.argument ?? '.', { out: io.flags.out });
    const filters = filtersFrom(io.flags, await rulesInForce(resolved.root));
    const paths = await scanPaths(io, resolved.root, resolved.scope);
    if (io.flags.since && !paths.length) { io.stdout(`Nothing changed since ${io.flags.since}.`); return EXIT.clean; }
    const files = liveCounter(io, 'finding methods,'), methods = liveCounter(io, 'scanning method'),
      units = liveCounter(io, 'checking file'), searches = liveCounter(io, 'searching');
    // A request that is being retried answers nothing, so the counter it belongs to would sit still and read as a hang. Whatever
    // the service said is worth more than a frozen number, and it is said on the counter's own line.
    // Every run writes down what it did, whether or not anyone asked to watch it, because the run you want the log of is the one
    // that already went wrong. perch doctor reads the end of it.
    const write = await openStore(resolved.out).startLog();
    const note = message => { write(message); io.debug(message); };
    // On the counter and in the log both. On the counter because a retry is the wait that looks like a hang, and in the log
    // because the counter is gone by the time anyone asks what the run was doing.
    const retrying = message => { methods.say(message); note(message); };
    const systemOne = metered(createSystemOne({ apiKey: io.env.PERCH_API_KEY || io.env.TYPESAFE_API_KEY, baseUrl: io.env.PERCH_BASE_URL, model: io.env.PERCH_MODEL_ID, log: retrying }), meter);
    // A file prints the moment it is finished rather than at the end, so a long run says what it is finding while it finds it.
    const said = new Set();
    const say = (path, findings) => {
      const block = formatScanReport(narrow(visibleFindings(findings), filters, min), { min, filters, summary: false, empty: '' });
      if (!block) return;
      // Only a file that printed counts as said. A file whose methods were quiet still gets findings later, from the rules about
      // whole files and from the searches, and marking it reported on the way past dropped every one of them.
      said.add(path);
      methods.clear();
      io.stdout(block + '\n');
    };
    let run;
    try {
      run = await scanRepository({ root: resolved.root, revision: await gitRevision(resolved.root), label: resolved.label, github: resolved.github, out: resolved.out,
        systemOne, analyzer: createSourceAnalyzer(), paths, parallel, min, filters, onFile: io.flags.json ? () => {} : say,
        progress: methods.update, unitProgress: units.update, searchProgress: searches.update, scanProgress: files.update,
        log: note, debug: note });
    } finally { files.clear(); methods.clear(); units.clear(); searches.clear(); }
    const store = openStore(resolved.out);
    const scan = await store.latestScan();
    // What this run was about, not everything perch knows. A run narrowed to one file used to end on the whole store's count,
    // so `--paths README.md` read nothing and reported eighteen problems in nine files as though it had just found them.
    const inScope = covers(paths);
    // Kept unnarrowed as well, so the tally can say what a filter passed over instead of calling the run clean.
    const everything = visibleFindings(splitStale(await store.issues(min, { scan }), scan).current)
      .filter(finding => inScope(finding.path));
    const issues = narrow(everything, filters, min);
    // Whatever has not gone past already: the rules about files and tests, which are asked after the walk. Then the tally, which
    // counts the whole run. What was read and what it cost is context for a person watching, and goes under it on stderr.
    const rest = issues.filter(finding => !said.has(finding.path));
    print(io, { run, issues, usage: meter.toJSON() },
      [formatScanReport(rest, { min, filters, summary: false, empty: '' }), scanTally(everything, min, undefined, filters)].filter(Boolean).join('\n\n'));
    io.note(scanCount(run), ...meter.lines());
    // A unit perch could not finish is reported like a method it could not read: on stderr, and in perch doctor. It does not
    // decide the exit code. A run that printed findings and then returned 1 told CI perch could not run, and one oversize file
    // made that permanent.
    if (run.incomplete?.length) io.note(`${run.incomplete.length} ${run.incomplete.length === 1 ? 'check' : 'checks'} incomplete; perch doctor lists them`, ...run.incomplete);
    // The scan passes when nothing it gates on came back. Which questions those are is on the questions, so a defect and a
    // vulnerability count the same as a rule you wrote.
    return gating(issues, min).length ? EXIT.found : EXIT.clean;
  },
  /** perch rules list, add, edit and remove: the rule file as something you can change without opening it. */
  rules(io) {
    const [action, name] = io.args;
    if (!['list', 'add', 'edit', 'remove'].includes(action)) throw new UsageError(`perch rules takes list, add, edit or remove, not ${action ?? 'nothing'}`);
    return manageRules(io, action, name);
  },
  async issues(io) {
    const root = await ownQuestions();
    const rules = root ? await rulesInForce(root) : [];
    if (io.flags.types) { io.stdout(formatFilterKeys(rules)); return; }
    const store = await storeFrom(io.flags);
    if (io.argument) {
      const finding = await store.findFinding(io.argument);
      await store.withSourceLines([finding]);
      print(io, finding, formatFinding(finding));
      return;
    }
    const min = threshold(io.flags.min);
    const filters = filtersFrom(io.flags, rules);
    const { findings: all, edited } = await openIssues(store, min, io);
    const findings = narrow(all, filters, min / 100);
    const closed = Boolean(io.flags.closed);
    const rows = visibleFindings(findings, { closed });
    const { from, size } = paging(io, filters);
    const page = rows.slice(from, Number.isFinite(size) ? from + size : undefined);
    print(io, page, formatIssues(page, min / 100, Infinity, { closed, filters }));
    io.note(issueCount({ open: visibleFindings(all).length, matched: rows.length, from, listed: page.length, size, edited,
      closed: closed ? 0 : all.length - visibleFindings(all).length, filtered: filters.length > 0 }));
  },
  async doctor(io) {
    const store = await storeFrom(io.flags);
    const versions = { perch: VERSION, node: process.version, platform: `${process.platform} ${process.arch}` };
    // Whether perch can run here, worked out before anything that assumes it can. A machine where nothing works still gets an
    // answer, which is the whole reason this command has this name.
    const root = await repoRoot(process.cwd()).catch(() => process.cwd());
    const checks = await runChecks({ root, out: store.out, env: io.env, versions });
    const [scan, run] = [await store.latestScan().catch(() => null), await store.latestRun().catch(() => null)];
    // The end of the log, on a run that did not finish cleanly. On one that did, the path to it is enough.
    const log = run && run.status !== 'complete' ? await store.tail(20) : [];
    print(io, { versions, out: store.out, checks, scan, run, log }, formatDoctor({ versions, scan, run, out: store.out, checks, log }));
    return checks.every(check => check.ok) ? EXIT.clean : EXIT.broke;
  },
  /**
   * Reads the file off disk rather than out of a commit, and records nothing. So it answers about work in progress, and
   * running it twenty times while fixing something does not move the numbers on the issue you are fixing.
   */
  async check(io) {
    if (!io.argument) throw new UsageError('perch check needs a path, a path::method, or an issue id');
    const meter = createMeter();
    const systemOne = metered(createSystemOne({ apiKey: io.env.PERCH_API_KEY || io.env.TYPESAFE_API_KEY, baseUrl: io.env.PERCH_BASE_URL, model: io.env.PERCH_MODEL_ID, log: io.debug }), meter);
    const root = await repoRoot(process.cwd());
    const only = io.flags.rules ? io.flags.rules.split(',').map(name => name.trim()).filter(Boolean) : [];
    const checked = await checkTarget({ target: io.argument, root, out: await resolveOut(io.flags.out), analyzer: createSourceAnalyzer(),
      systemOne, revision: await gitRevision(root), only, debug: io.debug });
    print(io, checked, formatCheck(checked));
    io.note(...meter.lines());
    return checked.clean ? EXIT.clean : EXIT.found;
  },
  /** Set issues aside, or put them back: a judgement you make about what the scan found, kept in the same log as everything else. */
  /** The skill, put where a coding assistant will read it. Nothing about your code is touched. */
  async setup(io) {
    const target = io.argument;
    if (!target) throw new UsageError(`perch setup takes ${TARGET_NAMES.join(', ')}`);
    const root = await repoRoot(process.cwd()).catch(() => process.cwd());
    const done = await installSkill({ root, target, force: Boolean(io.flags.force) });
    const said = done.wrote ? `${done.replaced ? 'Replaced' : 'Wrote'} ${done.path} for ${done.name}.`
      : done.same ? `${done.path} is already this skill.` : done.why;
    print(io, done, said);
    return done.wrote || done.same ? EXIT.clean : EXIT.usage;
  },
  async close(io) { await setAside(io, 'close'); },
  async reopen(io) { await setAside(io, 'reopen'); },
};

/**
 * A key belongs to a repository more often than to a shell, so one sitting in a .env beside it is used without being exported.
 * An ENOENT is the ordinary case of not having one; anything else is a file that is there and unreadable, which is worth saying.
 */
async function loadDotEnv() {
  const root = await repoRoot(process.cwd()).catch(() => process.cwd());
  try { process.loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function main(argv, { stdout = text => process.stdout.write(text + '\n'), stderr = text => process.stderr.write(text + '\n'), env = process.env } = {}) {
  if (env === process.env) await loadDotEnv();
  // A mistake gets the mistake and where to read about it. Printing the whole help over an error buries the error.
  const wrong = (message, where = '') => { stderr(`perch: ${message}`); stderr(`perch ${where} --help`.replace('  ', ' ')); return EXIT.usage; };
  let parsed;
  try { parsed = parseArgs(argv); }
  catch (error) { return wrong(error.message); }
  const { flags, positional } = parsed;
  const [typed = 'help', argument] = positional;
  const commandName = ALIASES[typed] ?? typed;
  const command = commands[commandName];
  // Answered before the command is checked or run, since asking what is running is not something you do to a command.
  if (flags.version) { stdout(VERSION); return EXIT.clean; }
  if (flags.help || commandName === 'help') { stdout(command ? usageFor(commandName) : usage); return EXIT.clean; }
  if (!command) { stderr(`perch: unknown command ${typed}`); stderr(`perch --help lists them`); return EXIT.usage; }
  try { checkFlags(flags, commandName); }
  catch (error) { return wrong(error.message, commandName); }
  const verbose = Boolean(flags.verbose);
  // The one place that knows what a terminal is and what the environment asked for.
  useColor(Boolean(process.stdout.isTTY) && !flags.json);
  const log = message => { if (verbose || !flags.json) stderr(`[perch] ${message}`); };
  const debug = message => { if (verbose) stderr(`[perch] ${message}`); };
  try {
    // A command that returns a number is saying what the exit code should be.
    const code = await command({ argument, args: positional.slice(1), flags, env, stdout, stderr, log, debug, verbose, note: noteFrom({ flags }, stderr) });
    return typeof code === 'number' ? code : EXIT.clean;
  } catch (error) {
    if (error instanceof UsageError) return wrong(error.message, commandName);
    stderr(`perch: ${error.message}`);
    if (verbose && error.stack) stderr(error.stack);
    return EXIT.broke;
  }
}
