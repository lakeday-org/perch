/** perch command line: scan, coverage, issues, check, close, rules, doctor. */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { git, repoRoot, revision as gitRevision } from './git.js';
import { resolveTarget } from './target.js';
import { loginCloud, logoutCloud } from './cloud-auth.js';
import { configuredSystemOne, credentialSource } from './cloud-client.js';
import { createResultStream, reportFindings, runContext } from './cloud-results.js';
import { configuredEnvironment } from './config.js';
import { createSourceAnalyzer } from './analysis.js';
import { jsonChunks, openStore, resolveOut } from './store.js';
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
import { coverageFindings, coverageRepository, withoutSource } from './coverage.js';
import { renderCoverageSite } from './coverage-html.js';
import { COVERAGE_KINDS, coverageCount, coverageDetails, formatCoverage, formatCoverageDiff, listedFindings, parseCoverageFilters } from './coverage-report.js';
import { formatDoctor, formatFilterKeys, gating, useColor, formatFinding, formatIssues, formatCheck, formatRules, formatScanReport, issueCount, relative, scanCount, scanTally, shownIssues, TOP, visibleFindings } from './report.js';

/**
 * Stamped into the bundle at build time, so it reports what is running rather than a number read off a package.json that may not
 * be the one this code came from. A build that is not sitting on its release tag says DEVELOPMENT and names the commit.
 */
export const VERSION = typeof PERCH_VERSION === 'string' ? PERCH_VERSION : 'dev';

/**
 * Every flag: how it is written, what it does, which commands take it, and what it does differently on the one command where the
 * shared sentence would be wrong.
 */
const options = {
  paths: ['--paths a,b', 'Only consider files under these repository paths', ['scan', 'coverage']],
  parallel: ['--parallel N', `How many methods to read at once (default ${DEFAULT_PARALLEL}; files and tests go ${UNIT_PARALLEL} at a time, alongside them)`, ['scan', 'coverage'],
    { coverage: `How many tests or methods to ask about at once (default ${DEFAULT_PARALLEL})` }],
  since: ['--since REF', 'Only what changed since this branch or commit', ['scan', 'coverage'],
    { coverage: 'Report only what changed since this branch or commit' }],
  all: ['--all', 'List every row instead of the top 10', ['scan', 'issues', 'coverage']],
  limit: ['--limit N', `Rows per page (default ${TOP})`, ['issues']],
  page: ['--page N', 'Which page of them, 1 is the first', ['issues']],
  closed: ['--closed', 'Include closed issues (worked and given up on, or nothing left to do)', ['issues']],
  min: ['--min P', `Only issues it is at least P percent sure of (default ${BELIEVED * 100}; --min 0 shows everything). On a rule, the floor for that one alone`, ['scan', 'issues', 'rules', 'coverage'],
    { coverage: `Only problems it is at least P percent sure of (default ${BELIEVED * 100}; --min 0 shows everything)` }],
  filter: ['--filter k=v', 'Only issues matching, e.g. type=security, kind=too big, severity=P1 (comma-separated)', ['scan', 'issues', 'coverage'],
    { coverage: 'Only problems of these kinds, e.g. kind=survived,kind=redundant' }],
  depth: ['--depth N', 'How many calls deep to follow each test (default 3)', ['coverage']],
  diff: ['--diff REF', 'Compare with the run saved at this branch or commit', ['coverage']],
  html: ['--html FILE', 'Where to write the HTML report (default coverage/index.html under --out)', ['coverage']],
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
  force: ['--force', 'setup: replace a skill file you have edited. scan, check: ask Perch Cloud again instead of using cached answers', ['setup', 'scan', 'check']],
  out: ['--out DIR', 'Results directory (default .perch)', ['scan', 'coverage', 'issues', 'check', 'close', 'reopen', 'doctor']],
  json: ['--json', 'Print JSON instead of a summary', ['scan', 'coverage', 'rules', 'issues', 'check', 'close', 'reopen', 'doctor', 'setup']],
  verbose: ['--verbose', 'Show every file, method, model call, and command', ['scan', 'coverage', 'issues', 'check']],
};

/** Other names that still work. */
const ALIASES = { findings: 'issues' };

const commandHelp = {
  login: { args: '[organization-id]', summary: 'Sign in to Perch Cloud', detail: 'Shows a device code to confirm in your browser. Stores a private login outside the repository. In CI, set PERCH_API_KEY to a CI token from the dashboard, or let a GitHub Actions job sign in with its own OIDC token.' },
  logout: { args: '', summary: 'Remove this device’s cloud login', detail: 'Removes the saved login from this device. CI credentials are revoked separately in the dashboard.' },
  scan: { args: '[target]', summary: 'Find issues', detail: `Scores every method with tree-sitter, then reads them with System One, callers and callees in view. Custom rules in ${RULES_FILE} and ${RULES_DIR}/ are asked in the same reading, so they cost nothing extra on a method perch was reading anyway.\n\nEvery run asks about every method in scope. Answers are cached by the endpoint rather than in .perch: Perch Cloud shares them across a repository's scans, locally and in CI. --force asks again and replaces what was cached.\n\ntarget is the file or directory to read, and defaults to where you are. Scans read the Git repository at HEAD. --paths and --since narrow the run, and --since origin/main is what CI wants. ignore in perch.yaml skips paths on a scan of the repository; a path you name is read anyway. Exits 3 on anything it found. Every type it asks about fails the run; scan_types in perch.yaml decides which those are, and defaults to defect and lint; --filter type=security asks about vulnerabilities. Questions go to Perch Cloud: sign in with perch login, or set PERCH_API_KEY to a CI token; a GitHub Actions job with id-token: write signs itself in. PERCH_BASE_URL sends them to another endpoint instead, with PERCH_API_KEY as its key. Defaults can be set in ~/.perch/config.toml.` },
  coverage: { args: '[target]', summary: 'Test coverage, and which tests are worth keeping', detail: `Predictive mutation testing. Generates mutants of every method a test reaches, one-line edits off the syntax tree, and asks Perch Cloud whether each test reaching the method would fail against each one. Lists the mutants that survive, the tests that kill none, and the tests that kill the same mutants as another. Runs no tests and reads nothing a test run wrote. A percentage is how sure the model is that a problem needs fixing.\n\n--since REF reports the problems in code the branch changed since REF. --diff REF compares with the run saved at REF. perch close <id> sets a problem aside.\n\ntarget is the file or directory to read, and defaults to where you are. --filter takes kind=, one of ${COVERAGE_KINDS.join(', ')}. Exits 3 when it lists a problem and 1 when it could not run. Asks Perch Cloud, the same way perch scan does. PERCH_BASE_URL sends it to another endpoint instead; PERCH_MODEL_ID selects the model.` },
  rules: { args: '[list | add <name> | edit <name> | remove <name>]', summary: `Change ${RULES_FILE} without opening it`, detail: `Custom rules are questions perch asks alongside its own, written in the same grammar as the ones it ships with in scan.yaml. perch scan asks them; this writes them, keeping comments and ordering.\n\nRules live in ${RULES_FILE} or in .yaml files under ${RULES_DIR}/. add writes to ${RULES_FILE} unless --file names a split file; edit and remove find the file a rule is in; list shows every file, or one file with --file.\n\nMost are a yes-or-no, so --ensure is usually the only flag needed. It covers what a parser can't: whether a comment says why, whether a test asserts what you claim.\n\n  perch rules add no-stale-docs --where "docs/**/*.md" --ensure_absent "docs for code that was deleted"\n\nAn answer that is not yes-or-no is written out: --ask with --type and the options or levels it offers, and --issue for what an answer means. --when names a question this one is only as likely as.\n\n  perch rules add handles_absence --type choice --each method --where "src/**/*.js" \\\n    --ask "How does this method handle a value that is missing?" \\\n    --options "checks=It checks for it; ignores=It carries on with the missing value" \\\n    --issue "type=defect,label=handles_absence,except=checks"` },
  issues: { args: '[issue-id]', summary: 'List what the scan found, or show one', detail: 'Worst first. --filter narrows the list, --types prints what it accepts, --closed includes closed ones, --all lists every row. Give it an id to see everything known about that method. perch findings does the same thing.' },
  check: { args: '<path | path::method | issue-id>', summary: 'Ask about one piece of code, uncommitted', detail: 'Reads that one file off disk and asks about the point you named: every rule that covers it, plus the scan\'s own questions for a method. --rules narrows it to specific rules, or to defect, security, refactor or docs. Nothing is committed or recorded, so run it on work in progress. Exits 3 while something is still wrong. Asks Perch Cloud, the same way perch scan does. PERCH_BASE_URL sends it to another endpoint instead; PERCH_MODEL_ID selects the model.' },
  close: { args: '<issue-id>...', summary: 'Set issues aside', detail: 'Stops an issue being listed: a false positive, or code you have looked at and are not changing. An id perch coverage printed closes that problem, and later coverage runs leave it out. --reason is kept and shown by perch issues <id>. It stays closed through later scans and later edits, and perch reopen is the only thing that brings it back.\n\nIt covers the kinds on that issue now, so a defect found in the method later is a new thing and is listed. --kind closes some of them and leaves the rest:\n\n  perch close 2638fb16 --kind docs' },
  reopen: { args: '<issue-id>...', summary: 'Put closed issues back', detail: 'Undoes perch close, all of it, or the kinds --kind names.' },
  setup: { args: `<${TARGET_NAMES.join(' | ')}>`, summary: 'Teach a coding assistant to use perch', detail: `Writes the perch skill into the assistant's configuration, so it knows to scan what a branch changed, to read the JSON rather than the table, that a finding is a probability rather than a located defect, to ask about one method after a fix, and to write a rule when the same mistake comes back.\n\n${Object.entries(TARGETS).map(([name, target]) => `  perch setup ${name}`.padEnd(28) + target.path).join('\n')}\n\nThe file can be edited once written: perch will not replace an edited one unless you pass --force.` },
  doctor: { args: '', summary: 'Check perch can run, and what the last run did', detail: 'Whether perch can run here: node, credentials, Git, the repository and commit, somewhere to write, and whether perch.yaml parses. Anything that fails says what to do about it, and the command exits 1.\n\nUnder that, the last run: every method it could not read with the error, every question it asked and what each raised, and the end of the log when a run did not finish. Names, paths, counts and error messages only, never source, so it can be pasted into a bug report as it stands.' },
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

Configuration: ~/.perch/config.toml (environment variables take precedence)

Environment:
${column([['PERCH_API_KEY', 'a Perch Cloud CI token, or the key for PERCH_BASE_URL'], ['PERCH_BASE_URL', 'scan, coverage, check: another endpoint instead of Perch Cloud, the exact URL to POST to; one ending in /decisions is OpenAI\'s Decisions API'], ['PERCH_MODEL_ID', 'scan, coverage, check: model ID (default: the one Perch Cloud serves, gpt-6-luna on the Decisions API, or jev-latest elsewhere)'], ['OPENAI_API_KEY', 'the Decisions API key, when PERCH_API_KEY is not set'], ['PERCH_MAX_QUESTIONS', 'scan, check: most questions per request, for a PERCH_BASE_URL model that does not report it'], ['PERCH_MAX_OPTIONS', 'scan, check: most options in one choice, likewise'], ['PERCH_ORGANIZATION', 'Perch Cloud organization, when a login has several'], ['PERCH_REPOSITORY', 'Perch Cloud repository ID, instead of the one the git remote names']])}`;

/** A command that takes no options, login and logout, says so by leaving them out rather than printing an empty heading. */
function usageFor(name) {
  const help = commandHelp[name];
  const own = Object.values(options).filter(([, , verbs]) => verbs.includes(name));
  return `perch ${name}: ${help.summary}

Usage: perch ${[name, help.args, own.length ? '[options]' : ''].filter(Boolean).join(' ')}

${wrap(help.detail)}${own.length ? `

Options:
${column(own.map(([flag, text, , differs]) => [flag, differs?.[name] ?? text]))}` : ''}`;
}

/**
 * What perch comes back with. A run that found something and a run that fell over are different things and used to be the same
 * number, so anything reading the code could not tell a report from a crash.
 */
export const EXIT = { clean: 0, broke: 1, usage: 2, found: 3 };

const valued = new Set(['paths', 'parallel', 'min', 'filter', 'depth', 'diff', 'html', 'out', 'reason', 'kind', 'limit', 'page', 'since', 'rules',
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
      // So is `--min --all`: the next flag is not a value, and taking it as one dropped the flag it was.
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '' || (eq < 0 && /^--[a-z]/.test(value))) throw new Error(`--${key} requires a value`);
      // A flag given twice is a mistake: keeping one of the two dropped the other without a word.
      if (key in flags) throw new Error(`--${key} is given twice`);
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

/**
 * `--paths a,b` as paths under the repository root, the way git names them. One that leaves the repository names nothing perch
 * reads, and a run that read nothing reported itself clean, so it is refused. `./src` and `src/` are `src`.
 */
const parsePaths = flags => (flags.paths ? flags.paths.split(',').map(path => path.trim()).filter(Boolean) : []).map(path => {
  const normal = posix.normalize(path.replaceAll('\\', '/')).replace(/\/$/, '');
  if (posix.isAbsolute(normal) || normal === '..' || normal.startsWith('../')) throw new UsageError(`--paths takes paths inside the repository; ${path} is outside it`);
  return normal;
}).filter(path => path !== '.');
/** A report flag's paths: split at commas, except those inside a glob's `{a,b}`, which are part of the pattern. */
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
/**
 * The rules in force, so `--filter rule=` can name one and a typo is answered with the list. A perch.yaml that does not parse is
 * an error to show. Read as no rules, it answered a filter naming a rule the file holds with there being none.
 */
const rulesInForce = async root => readRules(root, await gitRevision(root));
/** The findings a filter keeps, the surest match first: filtering for one kind of problem should rank by that problem, not by whatever else the method carries. With no filter the scan's own ranking stands. */
const narrow = (findings, filters, min) => findings.filter(finding => matchesFilters(finding, filters, min))
  .sort((a, b) => filters.length ? filterStrength(b, filters) - filterStrength(a, filters) : 0);
const threshold = (value, fallback = BELIEVED * 100) => { const min = value === undefined ? fallback : Number(value); if (!(min >= 0 && min <= 100)) throw new UsageError('--min must be a percentage, 0 to 100: how sure the scan has to be of an issue to list it'); return min; };
const positiveInteger = (flag, value, fallback) => { const number = value === undefined ? fallback : Number(value); if (!Number.isInteger(number) || number < 1) throw new UsageError(`${flag} must be a positive integer`); return number; };
/** Write the report's pages: index.html where --html says, and for a report split by file, files/ and its style and script beside it. */
async function writeCoverageSite(html, site) {
  const dir = dirname(html);
  await mkdir(dir, { recursive: true });
  if (site.assets.length) await mkdir(join(dir, 'files'), { recursive: true });
  for (const asset of site.assets) await writeFile(join(dir, asset.name), asset.text);
  for (const page of site.pages) await writeFile(join(dir, page.name), page.html);
  await writeFile(html, '');
  for (const part of site.index) await appendFile(html, part);
}

// JSON goes out a megabyte at a time, each piece ending at a token, so a report too long for one string still prints as valid JSON.
const print = (io, record, text) => { if (!io.flags.json) { io.stdout(text); return; } for (const chunk of jsonChunks(record)) io.stdout(chunk); };
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

/**
 * Counters that run at the same time, on one line. The methods, the rules about files and the searches are asked together, and
 * three counters taking turns on one line showed whichever answered last, flickering between them. A phase that has finished drops
 * off so the line says what is still going. Clearing one clears the line for a file to print under; the next answer redraws it.
 */
function liveCounters(io, ...doing) {
  const line = liveCounter(io, ''), counts = new Map();
  const draw = () => {
    // A phase with nothing to do is told 0 of 0, and is finished rather than going.
    const going = [...counts].filter(([, [done, total]]) => total == null || done < total);
    const text = (going.length ? going : [...counts].slice(-1)).map(([label, [done, total]]) => total ? `${label} ${done} of ${total}` : `${label} ${done}`).join(', ');
    if (text) line.say(text);
  };
  return doing.map(label => ({ update: (done, total) => { counts.set(label, [done, total]); draw(); }, say: line.say, clear: line.clear }));
}

/** The open issues at HEAD: findings for methods that no longer exist are dropped and counted. */
async function openIssues(store, min, io) {
  const root = (await store.latestRun())?.root ?? (await store.latestScan())?.root ?? null;
  // Parsing the tree is what says which findings are about code that still exists. Swallowing a failure here listed everything
  // the last scan found as though it were all still there, which is a wrong list rather than a missing one.
  const scan = root ? await analyzeTree({ root, revision: await gitRevision(root),
    out: store.out, analyzer: createSourceAnalyzer(), log: io.debug, debug: io.debug }) : null;
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

/**
 * The issue or coverage problem an id names, and the kinds a closure of it covers. A scan issue covers what it lists unless
 * --kind says otherwise; a coverage problem is one kind on one test or method, so it covers that kind. An id both could mean is
 * ambiguous rather than guessed.
 */
async function findingFor(store, ref) {
  const coverage = await coverageFindings(store.out, ref);
  let scanned = null;
  try { scanned = await store.findFinding(ref); } catch (error) { if (!coverage.length || !/^no finding/.test(error.message)) throw error; }
  const ids = [...(scanned ? [scanned.id] : []), ...coverage.map(finding => finding.id)];
  if (ids.length > 1) throw new Error(`finding id ${ref} is ambiguous: ${ids.join(', ')}`);
  if (scanned) return { finding: scanned, kinds: null };
  const [problem] = coverage;
  return { finding: { id: problem.id, method: problem.unit, path: problem.path, name: problem.name, line: problem.line }, kinds: [problem.kind] };
}

/** `perch close a1b2 c3d4 --reason "..."`, and its undo. Ids are the ones in the first column; a unique prefix is enough. */
async function setAside(io, verb) {
  if (!io.args.length) throw new UsageError(`perch ${verb} needs at least one issue id; perch issues or perch coverage lists them`);
  await ownQuestions();
  const store = await storeFrom(io.flags);
  const kinds = kindsFrom(io.flags);
  const done = [];
  for (const ref of io.args) {
    const { finding, kinds: covers } = await findingFor(store, ref);
    const named = kinds ?? covers;
    done.push(verb === 'close' ? await store.dismiss(finding, io.flags.reason ?? null, named) : await store.reopen(finding, named));
  }
  print(io, done, done.map(event => `${event.id}  ${event.name}  ${event.path}:${event.line ?? ''}`.trimEnd()
    + `  ${verb === 'close' ? 'closed' : 'reopened'}${event.kinds?.length ? `  ${event.kinds.join(', ')}` : ''}`).join('\n'));
}

/** What a scan covers: --paths as given, or what --since says a branch changed. */
// A scan covers the target it was given, narrowed further by --paths or --since. `perch scan docs/` is `--paths docs`, so a
// directory costs what it covers rather than what encloses it.
// Coverage passes since as null: a branch's tests and the code they reach are mostly in files it did not change, so it reads the
// whole target and --since only decides what it reports.
const scanPaths = async (io, root, scope = null, since = io.flags.since) => {
  const asked = since ? await changedPaths(root, since) : parsePaths(io.flags);
  if (!scope) return asked;
  // No --paths is the whole target. --since finding no changes is not that: it is a run with nothing to read, and widening it to
  // the target scanned every method under it.
  if (!io.flags.since && !asked.length) return [scope];
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
    // Everything, unless you say otherwise. A rule that covers the whole repository is a fine rule to want, and a rule about
    // tests covers every test without a where.
    await addRule(root, { name, ...(written.each === 'test' ? {} : { where: '**/*' }), ...written }, { file });
    io.stdout(`Added ${name} to ${file === undefined ? RULES_FILE : ruleFile(file)}.`);
    return EXIT.clean;
  }
  await editRule(root, name, written, { file });
  io.stdout(`Changed ${name}.`);
  return EXIT.clean;
}

const commands = {
  async login(io) { await loginCloud({ env: io.env, organization: io.argument, stdout: io.stdout }); },
  async logout(io) { await logoutCloud(io); },
  async scan(io) {
    const meter = createMeter();
    const parallel = positiveInteger('--parallel', io.flags.parallel, DEFAULT_PARALLEL);
    const min = threshold(io.flags.min) / 100;
    // The target comes first: a filter can name a rule, and the rules are read from the repository the target resolves to.
    const resolved = await resolveTarget(io.argument ?? '.', { out: io.flags.out });
    const filters = filtersFrom(io.flags, await rulesInForce(resolved.root));
    const paths = await scanPaths(io, resolved.root, resolved.scope);
    if (io.flags.since && !paths.length) { io.stdout(`Nothing changed since ${io.flags.since}.`); return EXIT.clean; }
    const files = liveCounter(io, 'finding methods,');
    const [methods, units, searches] = liveCounters(io, 'scanning method', 'checking file', 'searching');
    // A request that is being retried answers nothing, so the counter it belongs to would sit still and read as a hang. Whatever
    // the service said is worth more than a frozen number, and it is said on the counter's own line.
    // Every run writes down what it did, whether or not anyone asked to watch it, because the run you want the log of is the one
    // that already went wrong. perch doctor reads the end of it.
    const write = await openStore(resolved.out).startLog();
    const note = message => { write(message); io.debug(message); };
    // On the counter and in the log both. On the counter because a retry is the wait that looks like a hang, and in the log
    // because the counter is gone by the time anyone asks what the run was doing.
    const retrying = message => { methods.say(message); note(message); };
    const systemOne = metered(await configuredSystemOne({ env: io.env, root: resolved.root, log: retrying, command: 'scan', version: VERSION,
      force: Boolean(io.flags.force) }), meter);
    const revision = await gitRevision(resolved.root);
    const started = Date.now();
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], resolved.root).then(out => out.trim(), () => null);
    const where = await runContext(io.env, revision, branch === 'HEAD' ? null : branch);
    const full = !io.flags.since && !io.flags.paths && !resolved.scope;
    const stream = systemOne.startScan && resolved.kind === 'local'
      ? createResultStream(systemOne, { ...where, scope: full ? 'full' : 'partial', perch_version: VERSION, started_at: started },
        error => io.note(`Could not update scan progress in Perch Cloud: ${error.message}`)) : null;
    // A file prints the moment it is finished rather than at the end, so a long run says what it is finding while it finds it.
    const said = new Set();
    const say = (_path, findings) => {
      const shown = narrow(visibleFindings(findings), filters, min);
      const block = formatScanReport(shown, { min, filters, summary: false, empty: '' });
      if (!block) return;
      // What printed is said, not the file it is in. The rules about whole files, the `mentions` rules and the searches answer
      // beside the walk, often after their file has gone past, and marking the file reported dropped every one of them while
      // the tally still counted them.
      for (const finding of shown) if (shownIssues(finding, min, filters).length) said.add(finding.id);
      methods.clear();
      io.stdout(block + '\n');
    };
    let run, lastProgress = { completed: 0, total: 0 };
    try {
      run = await scanRepository({ root: resolved.root, revision, label: resolved.label, github: resolved.github, out: resolved.out,
        systemOne, analyzer: createSourceAnalyzer(), paths, named: [resolved.scope, ...parsePaths(io.flags)].filter(Boolean), parallel, min, filters,
        onFinding: finding => stream?.add(reportFindings(visibleFindings([finding]), min)),
        onProgress: value => { lastProgress = value; stream?.progress(value); },
        onFile: io.flags.json ? () => {} : say,
        progress: methods.update, unitProgress: units.update, searchProgress: searches.update, scanProgress: files.update,
        log: note, debug: note });
    } catch (error) {
      if (stream) await stream.finish({ finished_at: Date.now(), methods: lastProgress.completed, reused: 0, files: 0, exit_code: 1,
        error: String(error.message || 'Scan could not finish').slice(0, 500) }).catch(upload => io.note(`Could not send scan error to Perch Cloud: ${upload.message}`));
      throw error;
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
    // Whatever has not gone past already: the rules asked outside a method's reading, which report once they have all answered.
    // Then the tally, which counts the whole run. What was read and what it cost is context for a person watching, and goes under
    // it on stderr.
    const rest = issues.filter(finding => !said.has(finding.id));
    // A run that read no method and asked no rule found nothing because it looked at nothing. Saying "nothing to report" there
    // described the configuration as the code, so it says what emptied the scope instead.
    const readNothing = !run.methods && !run.checked;
    const tally = readNothing
      ? `Nothing was read: ${run.excluded ? `ignore in ${RULES_FILE} covers all ${run.excluded} ${run.excluded === 1 ? 'method' : 'methods'} in scope` : 'no methods or files in scope'}.`
      : scanTally(everything, min, undefined, filters);
    print(io, { run, issues, usage: meter.toJSON() },
      [formatScanReport(rest, { min, filters, summary: false, empty: '' }), tally].filter(Boolean).join('\n\n'));
    io.note(scanCount(run), ...meter.lines());
    // A unit perch could not finish is reported like a method it could not read: on stderr, and in perch doctor. It does not
    // decide the exit code. A run that printed findings and then returned 1 told CI perch could not run, and one oversize file
    // made that permanent.
    if (run.incomplete?.length) io.note(`${run.incomplete.length} ${run.incomplete.length === 1 ? 'check' : 'checks'} incomplete; perch doctor lists them`, ...run.incomplete);
    // A method or rule that got no answer after every retry is code nobody checked. What was found still prints, but the run did
    // not finish: it exits 1, so CI does not pass a scan that read none of the lint it was asked for during a provider outage.
    const unanswered = (run.failed ?? []).filter(result => result.incomplete !== true && !result.oversize);
    if (unanswered.length) io.note(`${unanswered.length} could not be read after retries, so this scan did not finish; perch doctor lists them`);
    // Otherwise the scan passes when nothing it gates on came back. Which questions those are is on the questions, so a defect and
    // a vulnerability count the same as a rule you wrote.
    const exit = unanswered.length ? EXIT.broke : gating(issues, min).length ? EXIT.found : EXIT.clean;
    if (stream) {
      // File rules finish after method readings; add any issues not already sent before publishing the scan.
      stream.add(reportFindings(everything, min));
      await stream.finish({ finished_at: Date.now(), methods: run.methods ?? 0, reused: 0,
        files: new Set((run.visited ?? []).map(visit => visit.path)).size, exit_code: exit })
        .then(saved => { if (saved.url) io.note(`Results: ${saved.url}`); },
          error => io.note(`Could not send results to Perch Cloud: ${error.message}`));
    }
    return exit;
  },
  /**
   * Which tests reach which methods, from the call graph and System One, with nothing run. Everything printed is read off the report
   * coverageRepository returns, which is also what --json prints and what the HTML page is drawn from, so the three agree.
   */
  async coverage(io) {
    // Everything a flag can get wrong is said before anything is parsed or asked, so a typo costs nothing.
    let filters;
    try { filters = parseCoverageFilters(io.flags.filter ?? ''); } catch (error) { throw new UsageError(error.message); }
    const parallel = positiveInteger('--parallel', io.flags.parallel, DEFAULT_PARALLEL);
    const depth = io.flags.depth === undefined ? undefined : positiveInteger('--depth', io.flags.depth);
    const min = threshold(io.flags.min) / 100;
    const meter = createMeter();
    const resolved = await resolveTarget(io.argument ?? '.', { out: io.flags.out });
    const paths = await scanPaths(io, resolved.root, resolved.scope, null);
    const files = liveCounter(io, 'finding methods,'), tests = liveCounter(io, 'reading test'), methods = liveCounter(io, 'reading method');
    // A request being retried answers nothing, so the counter would sit still and read as a hang. What the service said goes on
    // the counter's line instead, the same as a scan.
    const retrying = message => { tests.say(message); io.debug(message); };
    const systemOne = metered(await configuredSystemOne({ env: io.env, root: resolved.root, log: retrying }), meter);
    let report;
    try {
      report = await coverageRepository({ root: resolved.root, revision: await gitRevision(resolved.root), label: resolved.label, github: resolved.github,
        out: resolved.out, systemOne, analyzer: createSourceAnalyzer(), paths, named: [resolved.scope, ...parsePaths(io.flags)].filter(Boolean),
        depth, parallel, min, diff: io.flags.diff ?? null, since: io.flags.since ?? null, scanProgress: files.update, testProgress: tests.update, methodProgress: methods.update,
        log: io.debug, debug: io.debug });
    } finally { files.clear(); tests.clear(); methods.clear(); }
    report = { ...report, usage: meter.toJSON() };
    // The page is written whether or not anyone asked for JSON: it is the report a person opens, and it is the same run.
    const html = io.flags.html ? resolve(io.flags.html) : join(resolved.out, 'coverage', 'index.html');
    await writeCoverageSite(html, renderCoverageSite(report));
    const all = Boolean(io.flags.all);
    print(io, withoutSource(report), [formatCoverage(report, { min, filters, all }), io.flags.diff ? formatCoverageDiff(report) : ''].filter(Boolean).join('\n\n'));
    for (const unit of report.failed ?? []) io.debug(`could not ask about ${unit.subject} ${unit.name} (${unit.path}): ${unit.error}`);
    for (const line of coverageDetails(report)) io.debug(line);
    io.note(coverageCount(report, { min, filters, all }), `Report: ${relative(html)}`, ...meter.lines());
    // Every problem listed is one the run stands behind, so any at all is a result; the top-ten cut only decides what fits.
    return listedFindings(report, { min, filters }).length ? EXIT.found : EXIT.clean;
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
    // Outside a repository doctor still runs, from here; its repository check is the one that says so.
    const root = await repoRoot(process.cwd()).catch(() => process.cwd());
    let env = io.env, configError = null, loginError = null, source = null;
    try { env = await configuredEnvironment(io.env); }
    catch (error) { configError = error; }
    try { source = await credentialSource(env); }
    catch (error) { loginError = error; }
    const checks = await runChecks({ root, out: store.out, env, versions, credential: source?.kind });
    if (configError) checks.unshift({ name: 'config', ok: false, found: configError.message, fix: 'fix ~/.perch/config.toml' });
    if (loginError) checks.unshift({ name: 'login', ok: false, found: loginError.message, fix: 'run perch logout, then perch login' });
    // A saved scan or run that cannot be read is something doctor exists to say, so it is a failed check rather than nothing.
    const saved = (name, read) => read().catch(error => { checks.push({ name, ok: false, found: error.message, fix: `remove ${store.out} and run perch scan again` }); return null; });
    const [scan, run] = [await saved('last scan', () => store.latestScan()), await saved('last run', () => store.latestRun())];
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
    const root = await repoRoot(process.cwd());
    const systemOne = metered(await configuredSystemOne({ env: io.env, root, log: io.debug, command: 'check', version: VERSION,
      force: Boolean(io.flags.force) }), meter);
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
    const configured = ['login', 'scan', 'coverage', 'check'].includes(commandName) ? await configuredEnvironment(env) : env;
    const code = await command({ argument, args: positional.slice(1), flags, env: configured, stdout, stderr, log, debug, verbose, note: noteFrom({ flags }, stderr) });
    return typeof code === 'number' ? code : EXIT.clean;
  } catch (error) {
    if (error instanceof UsageError) return wrong(error.message, commandName);
    stderr(`perch: ${error.message}`);
    if (verbose && error.stack) stderr(error.stack);
    return EXIT.broke;
  }
}

/** For a test that loads the bundle: the parse is what runs on worker threads, and only from the bundle. */
export { analyzeFiles } from './analysis.js';
export { createSourceAnalyzer } from './analysis.js';
