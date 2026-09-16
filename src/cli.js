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
import { fixIssues, fixMethod, splitStale, underPath } from './fix.js';
import { createMeter, metered } from './meter.js';
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
  min: ['--min P', 'Only issues at P percent or more (default 50)', ['issues', 'fix']],
  model: ['--model M', `OpenAI model (default ${DEFAULT_MODEL}, or $OPENAI_MODEL)`, ['fix']],
  effort: ['--effort E', `Reasoning effort: ${EFFORTS.join(', ')} (default ${DEFAULT_EFFORT})`, ['fix']],
  out: ['--out DIR', 'Results directory (default .perch)', ['scan', 'issues', 'fix']],
  json: ['--json', 'Print JSON instead of a summary', ['scan', 'issues', 'fix']],
  verbose: ['--verbose', 'Show every file, method, model call, and command', ['scan', 'fix']],
};

const commandHelp = {
  scan: { args: '[target]', summary: 'Find issues', detail: 'Scores every method with tree-sitter, then reads them with System One (callers and callees in view). The first scan reads every method; later ones only what changed (--force rereads all). Needs TYPESAFE_API_KEY. target is a directory, owner/repo, or a GitHub URL.' },
  issues: { args: '[finding-id]', summary: 'List open issues, or show one', detail: 'Lists open issues at --min or more. --closed includes closed ones. With a finding id, everything known about that method.' },
  fix: { args: '[finding-id | path]', summary: 'Fix open issues, one commit each', detail: 'Works open issues, most serious first, up to --budget; with a path, only under that path; with a finding id, that one. An OpenAI agent rewrites each method and must pass measure, rescan, and run_tests before submit. Commits on the current branch; refuses main/master. Needs OPENAI_API_KEY and TYPESAFE_API_KEY.' },
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
    print(io, { scan: hunt, issues, usage: meter.toJSON() }, formatScanRun(hunt, issues, shown(io), meter.lines()));
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
    const shared = { out: store.out, model, systemOne, shell: createShell({ verbose: io.verbose, log: io.debug }), analyzer: createSourceAnalyzer(), ui: uiFor(io), log: io.log, debug: io.debug };
    if (io.argument && looksLikeId(io.argument)) {
      const finding = await store.findFinding(io.argument);
      const root = finding.root ?? (await store.latestHunt())?.root ?? await repoRoot(process.cwd());
      const record = await fixMethod({ finding, root, ...shared });
      print(io, record, formatFix(record));
      return;
    }
    const { findings: all, root } = await openIssues(store, min, io);
    const findings = underPath(all, io.argument);
    if (io.argument && !findings.length) throw new Error(`no open issues under ${io.argument}; perch issues lists them`);
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
