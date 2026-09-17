/** perch command line: scan, issues, fix. */
import { join } from 'node:path';
import { repoRoot, revision as gitRevision } from './git.js';
import { resolveTarget } from './target.js';
import { createModel, DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS } from './model.js';
import { createSystemOne } from './systemone.js';
import { createSourceAnalyzer } from './analysis.js';
import { openStore, resolveOut } from './store.js';
import { analyzeTree } from './scan.js';
import { DEFAULT_FIX_BUDGET, DEFAULT_PARALLEL, scanRepository } from './hunt.js';
import { BELIEVED, filterStrength, matchesFilters, parseFilters } from './questions.js';
import { fixIssues, fixMethod, splitStale, underPath } from './fix.js';
import { changedPaths, lintRepository, RULES_FILE } from './lint.js';
import { createMeter, metered } from './meter.js';
import { createShell } from './shell.js';
import { createUi } from './ui.js';
import { formatDoctor, formatFilterKeys, formatFinding, formatFix, formatFixes, formatIssues, formatLint, formatLintFile, formatScanRun, issueCount, scanCount, TOP, visibleFindings } from './report.js';

/** Stamped into the bundle at build time so `perch doctor` reports the version that is running, not one read from a stray file. */
export const VERSION = typeof PERCH_VERSION === 'string' ? PERCH_VERSION : 'dev';

const options = {
  paths: ['--paths a,b', 'Only consider files under these repository paths', ['scan']],
  budget: ['--budget N', `Work at most N issues (default ${DEFAULT_FIX_BUDGET})`, ['fix']],
  parallel: ['--parallel N', `How many methods to read at once (default ${DEFAULT_PARALLEL})`, ['scan']],
  since: ['--since REF', 'Only what changed since this branch or commit', ['lint']],
  force: ['--force', 'Read every method again, even ones unchanged since an earlier scan', ['scan', 'lint']],
  all: ['--all', 'List every row instead of the top 10', ['scan', 'issues']],
  limit: ['--limit N', `Rows per page (default ${TOP})`, ['issues']],
  page: ['--page N', 'Which page of them, 1 is the first', ['issues']],
  closed: ['--closed', 'Include closed issues (worked and given up on, or nothing left to do)', ['issues']],
  min: ['--min P', `Only issues the scan is at least P percent sure of (default ${BELIEVED * 100}; --min 0 shows everything it answered)`, ['issues', 'fix', 'lint']],
  filter: ['--filter k=v', 'Only issues matching, e.g. type=security, kind=too big, severity=P1 (comma-separated)', ['issues', 'fix']],
  types: ['--types', 'Print everything --filter accepts and stop', ['issues', 'fix']],
  model: ['--model M', `OpenAI model (default ${DEFAULT_MODEL}, or $OPENAI_MODEL)`, ['fix']],
  effort: ['--effort E', `Reasoning effort: ${EFFORTS.join(', ')} (default ${DEFAULT_EFFORT})`, ['fix']],
  reason: ['--reason R', 'Why you are setting these aside, kept on the record', ['close']],
  out: ['--out DIR', 'Results directory (default .perch)', ['scan', 'lint', 'issues', 'fix', 'close', 'reopen', 'doctor']],
  json: ['--json', 'Print JSON instead of a summary', ['scan', 'lint', 'issues', 'fix', 'close', 'reopen', 'doctor']],
  verbose: ['--verbose', 'Show every file, method, model call, and command', ['scan', 'lint', 'issues', 'fix']],
};

/** Other names that still work. */
const ALIASES = { findings: 'issues' };

const commandHelp = {
  scan: { args: '[target]', summary: 'Find issues', detail: 'Scores every method with tree-sitter, then reads them with System One (callers and callees in view). The first scan reads every method; later ones only what changed (--force rereads all). Needs TYPESAFE_API_KEY. target is a directory, owner/repo, or a GitHub URL.' },
  lint: { args: '', summary: 'Check your own rules against the code', detail: `Reads ${RULES_FILE}, or perch/*.yaml, and asks a model each rule about each file or method it names. Rules are the things a parser cannot prove: whether a comment says why, whether a listing honours a filter, whether a behaviour you claim is asserted by a test. Exits 1 when a rule is broken. --since limits it to what a branch changed, which is what CI wants. Needs TYPESAFE_API_KEY.` },
  issues: { args: '[issue-id]', summary: 'List what the scan found, or show one', detail: 'Lists open issues at --min or more, strongest first. --filter narrows them (--types prints what it accepts), --closed includes closed ones, --all lists every row. With an issue id, everything known about that method. perch findings is another name for this command.' },
  close: { args: '<issue-id>...', summary: 'Set issues aside', detail: 'Marks issues closed so they stop being listed and perch fix skips them: a false positive, or code you have looked at and are not changing. --reason is kept on the record and shown by perch issues <id>. A dismissal is about the method as it reads now, so editing that method brings the issue back.' },
  reopen: { args: '<issue-id>...', summary: 'Put closed issues back', detail: 'Undoes perch close.' },
  doctor: { args: '', summary: 'What the last run did, and what it could not read', detail: 'Prints versions, what the last scan and hunt did, and every method that could not be read with the error it failed on. Method names, paths and error messages only, no source and no answers, so it is safe to paste into a bug report.' },
  fix: { args: '[issue-id | path]', summary: 'Fix open issues, one commit each', detail: 'Works open issues, most serious first, up to --budget; with a path, only under that path; with an issue id, that one; --filter narrows which ones and works the surest match first (--types prints what it accepts). An OpenAI agent rewrites each method and must pass measure, rescan, and run_tests before submit. Commits on the current branch; refuses main/master. Needs OPENAI_API_KEY and TYPESAFE_API_KEY.' },
};

/** Help text is read in a terminal, which is 80 columns until proven otherwise. */
const wrap = text => text.split(' ').reduce((lines, word) => {
  if (lines.length && (lines.at(-1) + ' ' + word).length <= 80) lines[lines.length - 1] += ' ' + word;
  else lines.push(word);
  return lines;
}, []).join('\n');

const column = (rows, indent = '  ') => {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}`).join('\n');
};

const usage = `Usage: perch <command> [options]

Commands:
${column(Object.entries(commandHelp).map(([name, help]) => [`${name} ${help.args}`.trim(), help.summary]))}

Options:
${column([...Object.values(options).filter(([, , verbs]) => verbs.length === Object.keys(commandHelp).length).map(([flag, text]) => [flag, text]), ['-h, --help', 'This help; perch <command> --help for one command']])}

Environment:
${column([['TYPESAFE_API_KEY', 'scan, fix'], ['OPENAI_API_KEY', 'fix']])}`;

function usageFor(name) {
  const help = commandHelp[name];
  const own = Object.values(options).filter(([, , verbs]) => verbs.includes(name));
  return `perch ${name}: ${help.summary}

Usage: perch ${name} ${help.args ? `${help.args} ` : ''}[options]

${wrap(help.detail)}

Options:
${column(own.map(([flag, text]) => [flag, text]))}`;
}

const valued = new Set(['paths', 'budget', 'parallel', 'min', 'filter', 'model', 'effort', 'out', 'reason', 'limit', 'page', 'since']);
const switches = new Set(['force', 'all', 'json', 'verbose', 'closed', 'types', 'help']);

export function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (arg === '-h') { flags.help = true; continue; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    if (valued.has(key)) {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new Error(`--${key} requires a value`);
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
const modelFrom = ({ flags, env, log }) => { if (flags.effort !== undefined && !EFFORTS.includes(flags.effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}`); return createModel({ apiKey: env.OPENAI_API_KEY, model: flags.model || env.OPENAI_MODEL || DEFAULT_MODEL, effort: flags.effort ?? null, baseUrl: env.OPENAI_BASE_URL || undefined, log }); };
const storeFrom = async flags => openStore(await resolveOut(flags.out));
/** `--filter type=security,severity=P1` as tests a finding must pass; a bad clause is a usage error naming the real values. */
const filtersFrom = flags => { try { return parseFilters(flags.filter ?? ''); } catch (error) { throw new UsageError(error.message); } };
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
/** An in-place counter on stderr for interactive runs; silent when piped, verbose, or JSON. */
function liveCounter(io, noun) {
  const live = process.stderr.isTTY && !io.verbose && !io.flags.json;
  return { update: (done, total) => { if (live) process.stderr.write(`\r[perch] ${noun} ${done} of ${total}`); }, clear: () => { if (live) process.stderr.write('\r\x1b[K'); } };
}
/** A bare finding id, as opposed to a path: hex only, no separators. */
const looksLikeId = value => /^[0-9a-f]{4,8}$/.test(value);
/** Step-by-step progress with spinners and marks on a terminal; plain log lines when piped, verbose, or JSON. */
const uiFor = io => createUi({ live: Boolean(process.stderr.isTTY) && !io.verbose && !io.flags.json, log: io.log });

/** The open issues at HEAD: findings for methods that no longer exist are dropped and counted. */
async function openIssues(store, min, io) {
  const root = (await store.latestHunt())?.root ?? (await store.latestScan())?.root ?? null;
  const scan = root ? await analyzeTree({ root, revision: await gitRevision(root), out: store.out, analyzer: createSourceAnalyzer(), log: io.debug, debug: io.debug }).catch(() => null) : null;
  let findings = await store.issues(min / 100, { scan }), gone = 0;
  if (scan) { const { current, stale } = splitStale(findings, scan); findings = current; gone = stale.length; }
  return { findings, gone, root, scan };
}

/** `perch close a1b2 c3d4 --reason "..."`, and its undo. Ids are the ones in the first column; a unique prefix is enough. */
async function setAside(io, verb) {
  if (!io.args.length) throw new UsageError(`perch ${verb} needs at least one issue id; perch issues lists them`);
  const store = await storeFrom(io.flags);
  const done = [];
  for (const ref of io.args) {
    const finding = await store.findFinding(ref);
    done.push(verb === 'close' ? await store.dismiss(finding, io.flags.reason ?? null) : await store.reopen(finding));
  }
  print(io, done, done.map(event => `${event.id}  ${event.name}  ${event.path}:${event.line ?? ''}`.trimEnd() + `  ${verb === 'close' ? 'closed' : 'reopened'}`).join('\n'));
}

const commands = {
  async scan(io) {
    const meter = createMeter();
    const systemOne = metered(createSystemOne({ apiKey: io.env.TYPESAFE_API_KEY, log: io.debug }), meter);
    const parallel = positiveInteger('--parallel', io.flags.parallel, DEFAULT_PARALLEL);
    const resolved = await resolveTarget(io.argument ?? '.', { out: io.flags.out, log: io.log });
    const files = liveCounter(io, 'analyzed files'), methods = liveCounter(io, 'read methods');
    let hunt;
    try {
      hunt = await scanRepository({ root: resolved.root, revision: await gitRevision(resolved.root), label: resolved.label, github: resolved.github, out: resolved.out,
        systemOne, analyzer: createSourceAnalyzer(), paths: parsePaths(io.flags), parallel, force: Boolean(io.flags.force), progress: methods.update, scanProgress: files.update, log: io.debug, debug: io.debug });
    } finally { files.clear(); methods.clear(); }
    const store = openStore(resolved.out);
    const scan = await store.latestScan();
    const issues = visibleFindings(splitStale(await store.issues(BELIEVED, { scan }), scan).current);
    // The table first. What was read and what it cost is context for a person watching, and reads as a footnote to the table.
    print(io, { scan: hunt, issues, usage: meter.toJSON() }, formatScanRun(hunt, issues, shown(io), BELIEVED));
    io.note(scanCount(hunt), ...meter.lines());
  },
  /** Your rules, not perch's questions: a separate verb, a separate log, and an exit code CI can read. */
  async lint(io) {
    const meter = createMeter();
    const systemOne = metered(createSystemOne({ apiKey: io.env.TYPESAFE_API_KEY, log: io.debug }), meter);
    const root = await repoRoot(process.cwd());
    const revision = await gitRevision(root);
    const paths = io.flags.since ? await changedPaths(root, io.flags.since) : [];
    if (io.flags.since && !paths.length) { io.stdout(`Nothing changed since ${io.flags.since}.`); return 0; }
    const counter = io.verbose || io.flags.json ? { update: () => {}, clear: () => {} } : liveCounter(io, 'checked');
    // A file is printed the moment every rule has been asked of every part of it, rather than the run being held back to the end.
    let first = true;
    const say = file => {
      if (!file.findings.length) return;
      counter.clear();
      io.stdout(first ? formatLintFile(file) : `\n${formatLintFile(file)}`);
      first = false;
    };
    let run;
    try {
      run = await lintRepository({ root, revision, out: await resolveOut(io.flags.out), analyzer: createSourceAnalyzer(), systemOne, paths,
        min: threshold(io.flags.min) / 100, force: Boolean(io.flags.force), onFile: io.flags.json ? () => {} : say,
        progress: counter.update, log: io.debug, debug: io.debug });
    } finally { counter.clear(); }
    if (!io.flags.json && run.findings.length) io.stdout('');
    print(io, run, formatLint(run));
    io.note(...meter.lines());
    return run.findings.length ? 1 : 0;
  },
  async issues(io) {
    if (io.flags.types) { io.stdout(formatFilterKeys()); return; }
    const store = await storeFrom(io.flags);
    if (io.argument) {
      const finding = await store.findFinding(io.argument);
      await store.withSourceLines([finding]);
      print(io, finding, formatFinding(finding));
      return;
    }
    const min = threshold(io.flags.min);
    const filters = filtersFrom(io.flags);
    const { findings: all } = await openIssues(store, min, io);
    const findings = narrow(all, filters, min / 100);
    const closed = Boolean(io.flags.closed);
    const rows = visibleFindings(findings, { closed });
    const { from, size } = paging(io, filters);
    const page = rows.slice(from, Number.isFinite(size) ? from + size : undefined);
    print(io, page, formatIssues(page, min / 100, Infinity, { closed, filters }));
    io.note(issueCount({ open: visibleFindings(all).length, matched: rows.length, from, listed: page.length, size,
      closed: closed ? 0 : all.length - visibleFindings(all).length, filtered: filters.length > 0 }));
  },
  /** What to send when a run goes wrong: what perch did, and what it could not do. */
  async doctor(io) {
    const store = await storeFrom(io.flags);
    const [scan, hunt] = [await store.latestScan(), await store.latestHunt()];
    const findings = scan ? visibleFindings(await store.issues(BELIEVED, { scan })).length : 0;
    const versions = { perch: VERSION, node: process.version, platform: `${process.platform} ${process.arch}` };
    print(io, { versions, out: store.out, scan, hunt, findings }, formatDoctor({ versions, scan, hunt, out: store.out, findings }));
  },
  /** Set issues aside, or put them back: a judgement you make about what the scan found, kept in the same log as everything else. */
  async close(io) { await setAside(io, 'close'); },
  async reopen(io) { await setAside(io, 'reopen'); },
  /** Work the open issues in the checkout the scan ran in; a path narrows them, a finding id names one. */
  async fix(io) {
    if (io.flags.types) { io.stdout(formatFilterKeys()); return; }
    const budget = positiveInteger('--budget', io.flags.budget, DEFAULT_FIX_BUDGET);
    const min = threshold(io.flags.min);
    // Read the filter before anything is built: a clause that names nothing is a mistake to correct, not a missing API key.
    const filters = filtersFrom(io.flags);
    const model = modelFrom(io);
    const systemOne = createSystemOne({ apiKey: io.env.TYPESAFE_API_KEY, log: io.debug });
    const store = await storeFrom(io.flags);
    const shared = { out: store.out, model, systemOne, shell: createShell({ verbose: io.verbose, log: io.debug }), analyzer: createSourceAnalyzer(), ui: uiFor(io), log: io.log, debug: io.debug };
    if (io.argument && looksLikeId(io.argument)) {
      const finding = await store.findFinding(io.argument);
      const root = finding.root ?? (await store.latestHunt())?.root ?? await repoRoot(process.cwd());
      const record = await fixMethod({ finding, root, ...shared });
      print(io, record, formatFix(record));
      return;
    }
    const { findings: all, root } = await openIssues(store, min, io);
    const findings = narrow(underPath(all, io.argument), filters, min / 100);
    if (!findings.length) throw new Error(`nothing to fix${io.argument ? ` under ${io.argument}` : ''}${filters.length ? ' matching that filter' : ''}; perch issues lists what is open`);
    const batch = await fixIssues({ findings, budget, root: root ?? await repoRoot(process.cwd()), ...shared });
    print(io, batch, formatFixes(batch));
  },
};

/** Load a .env from the enclosing repository root (or the working directory); variables already in the environment win. */
async function loadDotEnv() {
  const root = await repoRoot(process.cwd()).catch(() => process.cwd());
  try { process.loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function main(argv, { stdout = text => process.stdout.write(text + '\n'), stderr = text => process.stderr.write(text + '\n'), env = process.env } = {}) {
  if (env === process.env) await loadDotEnv();
  let parsed;
  try { parsed = parseArgs(argv); }
  catch (error) { stderr(`perch: ${error.message}\n${usage}`); return 2; }
  const { flags, positional } = parsed;
  const [typed = 'help', argument] = positional;
  const commandName = ALIASES[typed] ?? typed;
  const command = commands[commandName];
  if (flags.help || commandName === 'help') { stdout(command ? usageFor(commandName) : usage); return 0; }
  if (!command) { stderr(`perch: unknown command ${typed}\n${usage}`); return 2; }
  try { checkFlags(flags, commandName); }
  catch (error) { stderr(`perch: ${error.message}\n${usageFor(commandName)}`); return 2; }
  const verbose = Boolean(flags.verbose);
  const log = message => { if (verbose || !flags.json) stderr(`[perch] ${message}`); };
  const debug = message => { if (verbose) stderr(`[perch] ${message}`); };
  try {
    // A command that returns a number is saying what the exit code should be; lint fails the build when a rule is broken.
    const code = await command({ argument, args: positional.slice(1), flags, env, stdout, stderr, log, debug, verbose, note: noteFrom({ flags }, stderr) });
    return typeof code === 'number' ? code : 0;
  } catch (error) {
    if (error instanceof UsageError) { stderr(`perch: ${error.message}\n${usageFor(commandName)}`); return 2; }
    stderr(`perch: ${error.message}`);
    if (verbose && error.stack) stderr(error.stack);
    return 1;
  }
}
