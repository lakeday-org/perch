/** perch command line: scan, issues, fix. */
import { join } from 'node:path';
import { repoRoot, revision as gitRevision } from './git.js';
import { resolveTarget } from './target.js';
import { createModel, DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS } from './model.js';
import { createSystemOne, DEFAULT_SYSTEM_ONE_MODEL } from './systemone.js';
import { createSourceAnalyzer } from './analysis.js';
import { openStore, resolveOut } from './store.js';
import { runScan } from './scan.js';
import { DEFAULT_FIX_BUDGET, DEFAULT_PARALLEL, runHunt } from './hunt.js';
import { runFixQueue, runOne, splitStale, underPath } from './fix.js';
import { runRefactor } from './refactor.js';
import { createShell } from './shell.js';
import { createUi } from './ui.js';
import { formatFinding, formatFix, formatFixes, formatIssues, formatScanRun, visibleFindings } from './report.js';

const options = {
  paths: ['--paths a,b', 'Only consider files under these repository paths', ['scan']],
  budget: ['--budget N', `Work at most N issues (default ${DEFAULT_FIX_BUDGET})`, ['fix']],
  parallel: ['--parallel N', `How many methods to read at once (default ${DEFAULT_PARALLEL})`, ['scan']],
  force: ['--force', 'Read every method again, even ones unchanged since an earlier scan', ['scan']],
  all: ['--all', 'List every row instead of the top 10', ['scan', 'issues']],
  closed: ['--closed', 'Include closed issues (worked and given up on, or nothing left to do)', ['issues']],
  min: ['--min P', 'Only list or work issues the model rates at P percent or more (default 50)', ['issues', 'fix']],
  model: ['--model M', `OpenAI model id (default ${DEFAULT_MODEL}, or $OPENAI_MODEL)`, ['fix']],
  effort: ['--effort E', `Reasoning effort for the OpenAI model's run: ${EFFORTS.join(', ')} (default ${DEFAULT_EFFORT})`, ['fix']],
  out: ['--out DIR', 'Results directory (default .perch in the current repository)', ['scan', 'issues', 'fix']],
  json: ['--json', 'Print the full record as JSON instead of a summary', ['scan', 'issues', 'fix']],
  verbose: ['--verbose', 'Show every file analyzed, method read or skipped, model call, and command run', ['scan', 'fix']],
};

const commandHelp = {
  scan: { args: '[target]', summary: 'Find the issues in a repository: defects, methods too big or too nested, misnamed, misdocumented, complex', detail: 'Analyzes every tracked source file with tree-sitter and records each method with its metrics and the calls and imports that link it to others. Then, starting at the riskiest method and walking its callers and callees, it sends one System One request per method with the method, the methods it calls, and its call sites, and asks: is there a reachable behavioral defect, on which line, of what kind, how severe; does any call misuse its callee; does the method do what its name and comment claim; is it documented; what refactor does it need; which neighbor to follow next. When a defect looks likely a second request asks whether the flagged line is actually executable. The first scan reads every method; later scans read only methods whose code changed since they were last read (--force reads everything again). Everything at 50% or more is an issue, and so is any method the metrics score at risk 70 or more, read or not. Prints the open issues. Needs TYPESAFE_API_KEY; always uses the jev-latest model.' },
  issues: { args: '[finding-id]', summary: 'List open issues, or show everything known about one method', detail: 'Lists every open issue at --min or more: the method, where, each issue it carries (the defect kind, too big, too nested, tangled conditions, misnamed, does not do what it claims, misdocumented, complex) with its probability, the severity of a defect, whether it is open or closed, and the commit once worked. An issue is closed once the work on it was given up or there was nothing left to do; closed issues are omitted unless --closed. Methods that no longer exist are not listed. With a finding id it prints everything known about that method.' },
  fix: { args: '[finding-id | path]', summary: 'Work the open issues in this checkout, most serious first, one commit each', detail: 'Works the open issues, strongest first, up to --budget of them; with a path, only those in that file or directory; with a finding id, that one. A defect: System One first confirms a caller can reach the flagged line (if not, the issue is closed with no model call); then an OpenAI model runs as an agent with the verifiers as tools, sees everything System One answered with the method\'s neighborhood, and must pass check_method (the patch parses and does not grow) and verify_with_system_one (the defect looks less likely, no caller newly misused) on the exact source it submits. Anything else (too big, too nested, tangled, misnamed, misdocumented, complex): the same kind of agent rewrites the method and its comment and must pass measure (the file\'s risk score comes down with complexity and nesting no higher) and run_tests (every test that reaches the method still passes; one already failing on the original is ignored) on the exact source it submits. An accepted result is committed on the current branch with the summary as its message; a rejected run leaves the checkout as it was. Refuses to run on main or master. Needs OPENAI_API_KEY and TYPESAFE_API_KEY.' },
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

const usage = `perch finds the issues in a repository and fixes them, one verified commit at a time.

Usage: perch <command> [arguments] [options]

Commands:
${column(Object.entries(commandHelp).map(([name, help]) => [`${name} ${help.args}`.trim(), help.summary]))}

Arguments:
${column([['target', 'A directory (default ".", resolved to its git root), or a GitHub repository as owner/repo or its URL'], ['path', 'A repository-relative file or directory; only issues under it are worked'], ['finding-id', 'The 8-character id printed next to every issue; a unique prefix is enough']])}

Options:
${column(Object.values(options).map(([flag, text, verbs]) => [flag, `${text} (${verbs.length === Object.keys(commandHelp).length ? 'all commands' : verbs.join(', ')})`]))}
  -h, --help        Show this help, or the help for one command

Environment:
Read from the shell, then from a .env file in the repository root.
${column([['TYPESAFE_API_KEY', `Required by scan and fix, which use the ${DEFAULT_SYSTEM_ONE_MODEL} model to read and judge code`], ['OPENAI_API_KEY', 'Required by fix, which uses an OpenAI model to write the code'], ['OPENAI_BASE_URL', 'OpenAI-compatible endpoint. Defaults to https://api.openai.com/v1'], ['OPENAI_MODEL', `OpenAI model for fix. Defaults to ${DEFAULT_MODEL}`]])}

Examples:
${column([['perch scan', 'Read every method the first time, only changed ones after; list the issues'], ['perch issues', 'The open issues'], ['perch issues 3f9c2a', 'Everything known about one method'], ['perch fix', 'Work the twenty most serious open issues, one commit each'], ['perch fix src/metrics.ts', 'Work the issues in one file'], ['perch fix 3f9c2a', 'Work one issue']])}`;

function usageFor(name) {
  const help = commandHelp[name];
  const own = Object.values(options).filter(([, , verbs]) => verbs.includes(name));
  return `perch ${name}: ${help.summary}

Usage: perch ${name} ${help.args ? `${help.args} ` : ''}[options]

${wrap(help.detail)}

Options:
${column(own.map(([flag, text]) => [flag, text]))}`;
}

const valued = new Set(['paths', 'budget', 'parallel', 'min', 'model', 'effort', 'out']);
const switches = new Set(['force', 'all', 'json', 'verbose', 'closed', 'help']);

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

const parsePaths = flags => flags.paths ? flags.paths.split(',').map(path => path.trim()).filter(Boolean) : [];
const modelFrom = ({ flags, env, log }) => { if (flags.effort !== undefined && !EFFORTS.includes(flags.effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}`); return createModel({ apiKey: env.OPENAI_API_KEY, model: flags.model || env.OPENAI_MODEL || DEFAULT_MODEL, effort: flags.effort ?? null, baseUrl: env.OPENAI_BASE_URL || undefined, log }); };
const storeFrom = async flags => openStore(await resolveOut(flags.out));
const threshold = (value, fallback = 50) => { const min = value === undefined ? fallback : Number(value); if (!(min >= 0 && min <= 100)) throw new UsageError('--min must be a number from 0 to 100'); return min; };
const positiveInteger = (flag, value, fallback) => { const number = value === undefined ? fallback : Number(value); if (!Number.isInteger(number) || number < 1) throw new UsageError(`${flag} must be a positive integer`); return number; };
const print = (io, record, text) => io.stdout(io.flags.json ? JSON.stringify(record, null, 2) : text);
const shown = io => (io.flags.all ? Infinity : undefined);
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
  const scan = root ? await runScan({ root, revision: await gitRevision(root), out: store.out, analyzer: createSourceAnalyzer(), log: io.debug, debug: io.debug }).catch(() => null) : null;
  let findings = await store.issues(min / 100, { scan }), gone = 0;
  if (scan) { const { current, stale } = splitStale(findings, scan); findings = current; gone = stale.length; }
  return { findings, gone, root, scan };
}

const commands = {
  async scan(io) {
    const systemOne = createSystemOne({ apiKey: io.env.TYPESAFE_API_KEY, log: io.debug });
    const parallel = positiveInteger('--parallel', io.flags.parallel, DEFAULT_PARALLEL);
    const resolved = await resolveTarget(io.argument ?? '.', { out: io.flags.out, log: io.log });
    const files = counter(io, 'analyzed files'), methods = counter(io, 'read methods');
    let hunt;
    try {
      hunt = await runHunt({ root: resolved.root, revision: await gitRevision(resolved.root), label: resolved.label, github: resolved.github, out: resolved.out,
        systemOne, analyzer: createSourceAnalyzer(), paths: parsePaths(io.flags), parallel, force: Boolean(io.flags.force), progress: methods.update, scanProgress: files.update, log: io.debug, debug: io.debug });
    } finally { files.clear(); methods.clear(); }
    const store = openStore(resolved.out);
    const scan = await store.latestScan();
    const issues = visibleFindings(splitStale(await store.issues(0.5, { scan }), scan).current);
    print(io, { scan: hunt, issues }, formatScanRun(hunt, issues, shown(io)));
  },
  async issues(io) {
    const store = await storeFrom(io.flags);
    if (io.argument) {
      const finding = await store.findFinding(io.argument);
      await store.withSourceLines([finding]);
      print(io, finding, formatFinding(finding));
      return;
    }
    const min = threshold(io.flags.min);
    const { findings, gone } = await openIssues(store, min, io);
    const closed = Boolean(io.flags.closed);
    print(io, visibleFindings(findings, { closed }), formatIssues(findings, min / 100, shown(io), { closed, gone }));
  },
  /** Work the open issues in the checkout the scan ran in; a path narrows them, a finding id names one. */
  async fix(io) {
    const budget = positiveInteger('--budget', io.flags.budget, DEFAULT_FIX_BUDGET);
    const min = threshold(io.flags.min);
    const model = modelFrom(io);
    const systemOne = createSystemOne({ apiKey: io.env.TYPESAFE_API_KEY, log: io.debug });
    const store = await storeFrom(io.flags);
    const shared = { out: store.out, model, systemOne, shell: createShell({ verbose: io.verbose, log: io.debug }), analyzer: createSourceAnalyzer(), ui: uiFor(io), log: io.log, debug: io.debug, simplify: runRefactor };
    if (io.argument && looksLikeId(io.argument)) {
      const finding = await store.findFinding(io.argument);
      const root = finding.root ?? (await store.latestHunt())?.root ?? await repoRoot(process.cwd());
      const record = await runOne({ finding, root, ...shared });
      print(io, record, formatFix(record));
      return;
    }
    const { findings: all, root } = await openIssues(store, min, io);
    const findings = underPath(all, io.argument);
    if (io.argument && !findings.length) throw new Error(`no open issues under ${io.argument}; perch issues lists them`);
    const batch = await runFixQueue({ findings, budget, root: root ?? await repoRoot(process.cwd()), ...shared });
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
  const [commandName = 'help', argument] = positional;
  const command = commands[commandName];
  if (flags.help || commandName === 'help') { stdout(command ? usageFor(commandName) : usage); return 0; }
  if (!command) { stderr(`perch: unknown command ${commandName}\n${usage}`); return 2; }
  const verbose = Boolean(flags.verbose);
  const log = message => { if (verbose || !flags.json) stderr(`[perch] ${message}`); };
  const debug = message => { if (verbose) stderr(`[perch] ${message}`); };
  try {
    await command({ argument, flags, env, stdout, stderr, log, debug, verbose });
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { stderr(`perch: ${error.message}\n${usageFor(commandName)}`); return 2; }
    stderr(`perch: ${error.message}`);
    if (verbose && error.stack) stderr(error.stack);
    return 1;
  }
}
