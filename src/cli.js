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
import { filterStrength, matchesFilters, parseFilters } from './questions.js';
import { fixIssues, fixMethod, splitStale, underPath } from './fix.js';
import { createMeter, metered } from './meter.js';
import { createShell } from './shell.js';
import { createUi } from './ui.js';
import { formatFilterKeys, formatFinding, formatFix, formatFixes, formatIssues, formatScanRun, scanCount, TOP, visibleFindings } from './report.js';

const options = {
  paths: ['--paths a,b', 'Only consider files under these repository paths', ['scan']],
  budget: ['--budget N', `Work at most N issues (default ${DEFAULT_FIX_BUDGET})`, ['fix']],
  parallel: ['--parallel N', `How many methods to read at once (default ${DEFAULT_PARALLEL})`, ['scan']],
  force: ['--force', 'Read every method again, even ones unchanged since an earlier scan', ['scan']],
  all: ['--all', 'List every row instead of the top 10', ['scan', 'findings']],
  closed: ['--closed', 'Include closed issues (worked and given up on, or nothing left to do)', ['findings']],
  min: ['--min P', 'Only methods expected to have more than P problems, on a scale where one certain issue is 100 (default 0: everything, ranked)', ['findings', 'fix']],
  filter: ['--filter k=v', 'Only issues matching, e.g. type=security, kind=too big, severity=P1 (comma-separated)', ['findings', 'fix']],
  types: ['--types', 'Print everything --filter accepts and stop', ['findings', 'fix']],
  model: ['--model M', `OpenAI model (default ${DEFAULT_MODEL}, or $OPENAI_MODEL)`, ['fix']],
  effort: ['--effort E', `Reasoning effort: ${EFFORTS.join(', ')} (default ${DEFAULT_EFFORT})`, ['fix']],
  out: ['--out DIR', 'Results directory (default .perch)', ['scan', 'findings', 'fix']],
  json: ['--json', 'Print JSON instead of a summary', ['scan', 'findings', 'fix']],
  verbose: ['--verbose', 'Show every file, method, model call, and command', ['scan', 'findings', 'fix']],
};

/** Older names that still work. */
const ALIASES = { issues: 'findings' };

const commandHelp = {
  scan: { args: '[target]', summary: 'Find issues', detail: 'Scores every method with tree-sitter, then reads them with System One (callers and callees in view). The first scan reads every method; later ones only what changed (--force rereads all). Needs TYPESAFE_API_KEY. target is a directory, owner/repo, or a GitHub URL.' },
  findings: { args: '[finding-id]', summary: 'List what the scan found, or show one', detail: 'Lists open findings at --min or more, strongest first. --filter narrows them (--types prints what it accepts), --closed includes closed ones, --all lists every row. With a finding id, everything known about that method. perch issues is an older name for this command.' },
  fix: { args: '[finding-id | path]', summary: 'Fix open issues, one commit each', detail: 'Works open issues, most serious first, up to --budget; with a path, only under that path; with a finding id, that one; --filter narrows which ones and works the surest match first (--types prints what it accepts). An OpenAI agent rewrites each method and must pass measure, rescan, and run_tests before submit. Commits on the current branch; refuses main/master. Needs OPENAI_API_KEY and TYPESAFE_API_KEY.' },
};

/** Wrap prose at 80 columns. */
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

const valued = new Set(['paths', 'budget', 'parallel', 'min', 'filter', 'model', 'effort', 'out']);
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
const threshold = (value, fallback = 0) => { const min = value === undefined ? fallback : Number(value); if (!(min >= 0)) throw new UsageError('--min must be a number of expected problems, 0 or more, where one certain issue is 100'); return min; };
const positiveInteger = (flag, value, fallback) => { const number = value === undefined ? fallback : Number(value); if (!Number.isInteger(number) || number < 1) throw new UsageError(`${flag} must be a positive integer`); return number; };
const print = (io, record, text) => io.stdout(io.flags.json ? JSON.stringify(record, null, 2) : text);
/** Counts and costs: context for a person watching, never part of the output a pipe reads. */
const noteFrom = (io, stderr) => (...lines) => { if (!io.flags.json) for (const line of lines.filter(Boolean)) stderr(line); };
const shown = io => (io.flags.all ? Infinity : TOP);
/** An in-place counter on stderr for interactive runs; silent when piped, verbose, or JSON. */
function counter(io, noun) {
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

const commands = {
  async scan(io) {
    const meter = createMeter();
    const systemOne = metered(createSystemOne({ apiKey: io.env.TYPESAFE_API_KEY, log: io.debug }), meter);
    const parallel = positiveInteger('--parallel', io.flags.parallel, DEFAULT_PARALLEL);
    const resolved = await resolveTarget(io.argument ?? '.', { out: io.flags.out, log: io.log });
    const files = counter(io, 'analyzed files'), methods = counter(io, 'read methods');
    let hunt;
    try {
      hunt = await scanRepository({ root: resolved.root, revision: await gitRevision(resolved.root), label: resolved.label, github: resolved.github, out: resolved.out,
        systemOne, analyzer: createSourceAnalyzer(), paths: parsePaths(io.flags), parallel, force: Boolean(io.flags.force), progress: methods.update, scanProgress: files.update, log: io.debug, debug: io.debug });
    } finally { files.clear(); methods.clear(); }
    const store = openStore(resolved.out);
    const scan = await store.latestScan();
    const issues = visibleFindings(splitStale(await store.issues(0.5, { scan }), scan).current);
    // The table first. What was read and what it cost is context for a person watching, and reads as a footnote to the table.
    print(io, { scan: hunt, issues, usage: meter.toJSON() }, formatScanRun(hunt, issues, shown(io)));
    io.note(scanCount(hunt), ...meter.lines());
  },
  async findings(io) {
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
    print(io, visibleFindings(findings, { closed }), formatIssues(findings, min / 100, shown(io), { closed }));
  },
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
    if (!findings.length) throw new Error(`nothing to fix${io.argument ? ` under ${io.argument}` : ''}${filters.length ? ' matching that filter' : ''}; perch findings lists what is open`);
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
    await command({ argument, flags, env, stdout, stderr, log, debug, verbose, note: noteFrom({ flags }, stderr) });
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { stderr(`perch: ${error.message}\n${usageFor(commandName)}`); return 2; }
    stderr(`perch: ${error.message}`);
    if (verbose && error.stack) stderr(error.stack);
    return 1;
  }
}
