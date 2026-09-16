/** perch command line: scan, hunt, issues, fix, refactor, report. */
import { join } from 'node:path';
import { repoRoot, revision as gitRevision } from './git.js';
import { resolveTarget } from './target.js';
import { createModel, DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS } from './model.js';
import { createSystemOne, DEFAULT_SYSTEM_ONE_MODEL } from './systemone.js';
import { createSourceAnalyzer } from './analysis.js';
import { openStore, resolveOut } from './store.js';
import { runScan } from './scan.js';
import { DEFAULT_BUDGET, DEFAULT_PARALLEL, runHunt } from './hunt.js';
import { runFix, runFixQueue, splitStale, underPath } from './fix.js';
import { DEFAULT_MIN_RISK, runRefactorQueue } from './refactor.js';
import { createShell } from './shell.js';
import { createUi } from './ui.js';
import { formatFinding, formatFix, formatFixes, formatHunt, formatIssues, formatScan, visibleFindings } from './report.js';

const options = {
  paths: ['--paths a,b', 'Only consider files under these repository paths', ['scan', 'hunt']],
  budget: ['--budget N', `Stop after N methods questioned (hunt) or N findings worked (fix, refactor) (default ${DEFAULT_BUDGET})`, ['hunt', 'fix', 'refactor']],
  parallel: ['--parallel N', `How many methods to question at once (default ${DEFAULT_PARALLEL})`, ['hunt']],
  force: ['--force', 'Question every method again, even ones unchanged since an earlier hunt', ['hunt']],
  all: ['--all', 'List every row instead of the top 10', ['scan', 'hunt', 'issues', 'report']],
  closed: ['--closed', 'Include closed findings (every attempt to fix them was rejected)', ['issues']],
  min: ['--min N', `Only list or fix methods the model rates at N percent or more (default 50); for refactor, only methods with a risk score of N or more (default ${DEFAULT_MIN_RISK} for the whole repository; a named path takes every method in it)`, ['issues', 'fix', 'refactor']],
  model: ['--model M', `OpenAI model id (default ${DEFAULT_MODEL}, or $OPENAI_MODEL)`, ['fix', 'refactor']],
  effort: ['--effort E', `Reasoning effort for every OpenAI call: ${EFFORTS.join(', ')} (default ${DEFAULT_EFFORT}); System One does the judging, so the generator rarely needs to think`, ['fix', 'refactor']],
  out: ['--out DIR', 'Results directory (default .perch in the current repository)', ['scan', 'hunt', 'fix', 'refactor', 'issues', 'report']],
  json: ['--json', 'Print the full record as JSON instead of a summary', ['scan', 'hunt', 'fix', 'refactor', 'issues', 'report']],
  verbose: ['--verbose', 'Show every file analyzed, method questioned or skipped, model call, and command run', ['scan', 'hunt', 'fix', 'refactor']],
};

const commandHelp = {
  scan: { args: '[target]', summary: 'Score every file by how likely it is to hide a bug', detail: 'Analyzes every tracked source file with tree-sitter, records each file and method with its metrics and the calls and imports that link them, and ranks the files by risk score. Reads straight from git: no worktree, no commands, no model. Hunt starts from the methods in those files.' },
  hunt: { args: '[target]', summary: 'Walk the method graph from riskiest down, asking what is wrong with each method', detail: 'Starts at the riskiest method and walks its callers and callees before moving to the next riskiest. For each method it sends one System One request carrying the method, the methods it calls, and its call sites, and asks: is there a reachable behavioral defect, on which line, of what kind, how severe; does any call misuse its callee; does the method do what its name and comment claim; is it documented; what refactor does it need; and which neighbor to follow next. When a defect looks likely, a second request asks whether the flagged line is actually executable given the method\'s own guards. Everything at 50% or more becomes an issue: defects, a recommended refactor, a method that does not do what it claims, one a caller cannot learn the contract of. Every answer is appended to events.jsonl, and a method whose source has not changed since it was last hunted is skipped unless --force is given. Needs TYPESAFE_API_KEY; always uses the jev-latest model.' },
  issues: { args: '[finding-id]', summary: 'List open issues, or show everything answered about one finding', detail: 'Reads the events log and lists every open finding at --min or more: the method, where, each issue it carries (the defect kind, the refactor it needs, does not do what it claims, misdocumented) with its probability, the severity of a defect, and whether it is open or closed. A finding is closed once every attempt to fix its defect was rejected; closed findings are omitted unless --closed. With a finding id it prints every answer for that method, including the line of code it points at.' },
  fix: { args: '[path]', summary: 'Fix open defects in this checkout, one commit per fix, judged by System One and the metrics', detail: 'Works the open defects, most likely first, up to --budget of them; with a path, only the defects in that file or directory. Each one is first put to System One again: can a real caller reach the flagged line given the method\'s own guards? If not, the finding is closed and no generative call is spent. Otherwise an OpenAI model sees everything System One answered about the method (every defect kind with its probability, the line, severity, which calls and callers look wrong) with the same neighborhood the hunt used, and returns the corrected method and nothing else. The method is spliced in by line range and must parse without adding nesting, more than one branch, or more than a point of risk. System One then asks the hunt\'s questions again over the patched method: the defect and its kind must look less likely than before, no caller newly misused, nothing changed beyond the defect. No test is run. A fix that passes is committed on the current branch with the summary as its message; a rejected attempt leaves the checkout as it was. Three attempts, each fed the previous rejection and the source it returned. Refuses to run on main or master. A finding id in place of the path works one finding. Needs OPENAI_API_KEY and TYPESAFE_API_KEY.' },
  refactor: { args: '[path]', summary: 'Simplify the riskiest methods the scan sees in this checkout, one commit per method, without changing behavior', detail: 'Independent of the hunt: works from the scan\'s tree-sitter metrics. Takes the methods with a risk score of --min or more, riskiest first, up to --budget of them; with a path, only the methods in that file or directory. For each one an OpenAI model sees the method with its comment, its metrics (risk, maintainability, complexity, nesting, lines), and the same neighborhood the hunt would show, and returns a rewrite of that region: the method, its comment, and any helpers split out beside it. The rewrite must parse, keep the method\'s name, and measure better: the method\'s risk score lower with complexity and nesting no higher, and the file as a whole no deeper, no more complex, and no more than a point riskier. Every test that reaches the method (or the whole suite, when none does) must still pass. System One then compares the two versions with the same neighborhood: behavior unchanged, no defect picked up, the name still true. A rewrite that passes is committed on the current branch with the summary as its message; a rejected attempt leaves the checkout as it was. Three attempts, each fed the previous rejection. Refuses to run on main or master. Needs OPENAI_API_KEY and TYPESAFE_API_KEY.' },
  report: { args: '', summary: 'Summarize the latest hunt: which methods were questioned and what came back', detail: 'Prints the most recent hunt: every method questioned that has an issue, strongest first, with the issues, severity, and location.' },
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

const usage = `perch walks a repository's method graph and asks a System One model where the bugs are.

Usage: perch <command> [arguments] [options]

Commands:
${column(Object.entries(commandHelp).map(([name, help]) => [`${name} ${help.args}`.trim(), help.summary]))}

Arguments:
${column([['target', 'A directory (default ".", resolved to its git root), or a GitHub repository as owner/repo or its URL'], ['path', 'A repository-relative file or directory; only findings under it are worked'], ['finding-id', 'The 8-character id printed by hunt and issues; a unique prefix is enough']])}

Options:
${column(Object.values(options).map(([flag, text, verbs]) => [flag, `${text} (${verbs.length === Object.keys(commandHelp).length ? 'all commands' : verbs.join(', ')})`]))}
  -h, --help        Show this help, or the help for one command

Environment:
Read from the shell, then from a .env file in the repository root.
${column([['TYPESAFE_API_KEY', `Required by hunt and fix, which always use the ${DEFAULT_SYSTEM_ONE_MODEL} model to question code`], ['OPENAI_API_KEY', 'Required by fix and refactor, which use an OpenAI model to write the code'], ['OPENAI_BASE_URL', 'OpenAI-compatible endpoint. Defaults to https://api.openai.com/v1'], ['OPENAI_MODEL', `OpenAI model for fix and refactor. Defaults to ${DEFAULT_MODEL}`]])}

Examples:
${column([['perch scan', 'The riskiest files, with overall scores'], ['perch hunt --budget 40', 'Question forty methods, riskiest first'], ['perch issues', 'Open issues: defects, refactors, misaligned and misdocumented methods'], ['perch issues 3f9c2a', 'Everything the model answered about one method'], ['perch fix --budget 5', 'Fix five open defects, one commit each'], ['perch refactor src/metrics.ts', 'Simplify the riskiest methods in one file, one commit each'], ['perch fix --help', 'Details for one command']])}`;

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
const noTarget = (name, argument) => { if (argument !== undefined) throw new UsageError(`${name} takes no target; use --out to pick a results directory`); };
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
/** What fix and refactor share: the models, the shell, the analyzer, and the results directory. */
async function workers(io) {
  const model = modelFrom(io);
  const systemOne = createSystemOne({ apiKey: io.env.TYPESAFE_API_KEY, log: io.debug });
  const store = await storeFrom(io.flags);
  return { store, shared: { out: store.out, model, systemOne, shell: createShell({ verbose: io.verbose, log: io.debug }), analyzer: createSourceAnalyzer(), ui: uiFor(io), log: io.log, debug: io.debug } };
}

const commands = {
  async scan(io) {
    const resolved = await resolveTarget(io.argument ?? '.', { out: io.flags.out, log: io.log });
    const files = counter(io, 'analyzed files');
    let scan;
    try {
      scan = await runScan({ root: resolved.root, revision: await gitRevision(resolved.root), label: resolved.label, github: resolved.github, out: resolved.out,
        analyzer: createSourceAnalyzer(), paths: parsePaths(io.flags), progress: files.update, log: io.log, debug: io.debug });
    } finally { files.clear(); }
    print(io, scan, formatScan(scan, shown(io)));
  },
  async hunt(io) {
    const systemOne = createSystemOne({ apiKey: io.env.TYPESAFE_API_KEY, log: io.log });
    const budget = positiveInteger('--budget', io.flags.budget, DEFAULT_BUDGET), parallel = positiveInteger('--parallel', io.flags.parallel, DEFAULT_PARALLEL);
    const resolved = await resolveTarget(io.argument ?? '.', { out: io.flags.out, log: io.log });
    const files = counter(io, 'analyzed files'), methods = counter(io, 'questioned methods');
    let hunt;
    try {
      hunt = await runHunt({ root: resolved.root, revision: await gitRevision(resolved.root), label: resolved.label, github: resolved.github, out: resolved.out,
        systemOne, analyzer: createSourceAnalyzer(), paths: parsePaths(io.flags), budget, parallel, force: Boolean(io.flags.force), progress: methods.update, scanProgress: files.update, log: io.log, debug: io.debug });
    } finally { files.clear(); methods.clear(); }
    print(io, hunt, formatHunt(hunt, shown(io)));
  },
  /** Work the open defects the last hunt found, in the checkout it ran in; a path narrows them, a finding id names one. */
  async fix(io) {
    const budget = positiveInteger('--budget', io.flags.budget, DEFAULT_BUDGET);
    const min = threshold(io.flags.min);
    const { store, shared } = await workers(io);
    const root = (await store.latestHunt())?.root;
    if (io.argument && looksLikeId(io.argument)) {
      const finding = await store.findFinding(io.argument);
      const findingRoot = finding.root ?? root;
      if (!findingRoot) throw new Error(`finding ${finding.id} has no repository recorded; hunt again`);
      const record = await runFix({ finding, root: findingRoot, ...shared });
      print(io, record, formatFix(record));
      return;
    }
    const findings = underPath(await store.findings(min / 100), io.argument);
    if (io.argument && !findings.length) throw new Error(`no open defects under ${io.argument}; perch issues lists what the hunt found`);
    const batch = await runFixQueue({ findings, budget, root, ...shared });
    print(io, batch, formatFixes(batch));
  },
  /** Simplify the riskiest methods the scan sees in this checkout, by tree-sitter metrics alone; a path narrows them. */
  async refactor(io) {
    if (io.argument && looksLikeId(io.argument)) throw new UsageError('refactor takes a path, not a finding id; it works from the scan, not the hunt');
    const budget = positiveInteger('--budget', io.flags.budget, DEFAULT_BUDGET);
    // A named path means "improve this": every method in it, riskiest first, unless --min says otherwise. The repo-wide sweep keeps the threshold.
    const min = io.flags.min !== undefined ? threshold(io.flags.min) : io.argument ? 0 : DEFAULT_MIN_RISK;
    const { shared } = await workers(io);
    const root = await repoRoot(process.cwd());
    const batch = await runRefactorQueue({ root, path: io.argument ?? null, budget, min, ...shared });
    if (io.argument && !batch.open && !batch.fixes.length) throw new Error(`no methods under ${io.argument}${min ? ` at risk ${min} or more` : ''}; perch scan --all shows the files`);
    print(io, batch, formatFixes(batch));
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
    let findings = await store.issues(min / 100), gone = 0;
    // A finding for a method that no longer exists at HEAD is history, not an issue.
    const root = (await store.latestHunt())?.root;
    if (root && findings.length) {
      const scan = await runScan({ root, revision: await gitRevision(root), out: store.out, analyzer: createSourceAnalyzer(), log: io.debug, debug: io.debug }).catch(() => null);
      if (scan) { const { current, stale } = splitStale(findings, scan); findings = current; gone = stale.length; }
    }
    const closed = Boolean(io.flags.closed);
    print(io, visibleFindings(findings, { closed }), formatIssues(findings, min / 100, shown(io), { closed, gone }));
  },
  async report(io) {
    noTarget('report', io.argument);
    const store = await storeFrom(io.flags);
    const hunt = await store.latestHunt();
    if (!hunt) throw new Error(`no hunts found under ${join(store.out, 'hunts')}; run perch hunt first`);
    await store.withSourceLines(hunt.visited ?? []);
    print(io, hunt, formatHunt(hunt, shown(io)));
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
