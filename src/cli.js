/** perch command line: scan, hunt, issues, fix, refactor, publish, report. */
import { join } from 'node:path';
import { repoRoot, revision as gitRevision } from './git.js';
import { resolveTarget } from './target.js';
import { createModel, DEFAULT_MODEL } from './model.js';
import { createSystemOne, DEFAULT_SYSTEM_ONE_MODEL } from './systemone.js';
import { createSourceAnalyzer } from './analysis.js';
import { openStore, resolveOut } from './store.js';
import { runScan } from './scan.js';
import { DEFAULT_BUDGET, DEFAULT_PARALLEL, runHunt } from './hunt.js';
import { runFix, runFixQueue, underPath } from './fix.js';
import { runRefactor } from './refactor.js';
import { createShell } from './shell.js';
import { publishFinding } from './issues.js';
import { formatFinding, formatFix, formatFixes, formatHunt, formatIssues, formatPublished, formatScan, visibleFindings } from './report.js';

const options = {
  paths: ['--paths a,b', 'Only consider files under these repository paths', ['scan', 'hunt']],
  budget: ['--budget N', `Stop after N methods questioned (hunt) or N findings worked (fix, refactor) (default ${DEFAULT_BUDGET})`, ['hunt', 'fix', 'refactor']],
  parallel: ['--parallel N', `How many methods to question at once (default ${DEFAULT_PARALLEL})`, ['hunt']],
  force: ['--force', 'Question every method again, even ones unchanged since an earlier hunt', ['hunt']],
  all: ['--all', 'List every row instead of the top 10', ['scan', 'hunt', 'issues', 'report']],
  closed: ['--closed', 'Include closed findings (discarded, or their GitHub issue closed)', ['issues']],
  min: ['--min P', 'Only list or work methods the model rates at P percent or more (default 50)', ['issues', 'fix', 'refactor']],
  model: ['--model M', `OpenAI model id (default ${DEFAULT_MODEL}, or $OPENAI_MODEL)`, ['fix', 'refactor']],
  out: ['--out DIR', 'Results directory (default .perch in the current repository)', ['scan', 'hunt', 'fix', 'refactor', 'publish', 'issues', 'report']],
  json: ['--json', 'Print the full record as JSON instead of a summary', ['scan', 'hunt', 'fix', 'refactor', 'publish', 'issues', 'report']],
  verbose: ['--verbose', 'Show every file analyzed, method questioned or skipped, model call, and command run', ['scan', 'hunt', 'fix', 'refactor']],
};

const commandHelp = {
  scan: { args: '[target]', summary: 'Score every file by how likely it is to hide a bug', detail: 'Analyzes every tracked source file with tree-sitter, records each file and method with its metrics and the calls and imports that link them, and ranks the files by risk score. Reads straight from git: no worktree, no commands, no model. Hunt starts from the methods in those files.' },
  hunt: { args: '[target]', summary: 'Walk the method graph from riskiest down, asking what is wrong with each method', detail: 'Starts at the riskiest method and walks its callers and callees before moving to the next riskiest. For each method it sends one System One request carrying the method, the methods it calls, and its call sites, and asks: is there a reachable behavioral defect, on which line, of what kind, how severe; does any call misuse its callee; does the method do what its name and comment claim; is it documented; what refactor does it need; and which neighbor to follow next. When a defect looks likely, a second request asks whether the flagged line is actually executable given the method\'s own guards. Everything at 50% or more becomes an issue: defects, a recommended refactor, a method that does not do what it claims, one a caller cannot learn the contract of. Every answer is appended to events.jsonl, and a method whose source has not changed since it was last hunted is skipped unless --force is given. Needs TYPESAFE_API_KEY; always uses the jev-latest model.' },
  issues: { args: '[finding-id]', summary: 'List open issues, or show everything answered about one finding', detail: 'Reads the events log and lists every open finding at --min or more: the method, where, each issue it carries (the defect kind, the refactor it needs, does not do what it claims, misdocumented) with its probability, the severity of a defect, whether it is open or closed, and the pull request if one was opened. A finding is closed when its GitHub issue is closed or when everything it raised has been worked and discarded; closed findings are omitted unless --closed. With a finding id it prints every answer for that method, including the line of code it points at.' },
  fix: { args: '[path]', summary: 'Fix open defects in this checkout, proving each with a regression test, one commit per fix', detail: 'Works the open defects, most likely first, up to --budget of them; with a path, only the defects in that file or directory. Each one is first put to System One again: can a real caller reach the flagged line given the method\'s own guards? If not, the finding is closed and no generative call is spent. Otherwise an OpenAI model sees the finding with the same context the hunt used, an existing test from the project, and how the project runs one test file, and returns the corrected method and one new regression test. The method is spliced in by line range and must parse without raising complexity, nesting, or risk. System One reads the test: it must import the real method, exercise the flagged defect, assert on behavior, and not pass on the original. Then, in this checkout, the test must fail on the original with an assertion and pass on the patch, and the existing tests that reach the method must still pass. System One questions the patched method again: the defect and its kind must look less likely than the hunt found them, no caller newly misused, nothing changed beyond the defect. A proven fix is committed on the current branch with the summary as its message; a rejected attempt leaves the checkout as it was. Three attempts, each fed the previous rejection. Refuses to run on main or master. A finding id in place of the path works one finding. Needs OPENAI_API_KEY and TYPESAFE_API_KEY.' },
  refactor: { args: '[path]', summary: 'Improve methods with open design issues in this checkout, one commit per method, without changing behavior', detail: 'Works the open design issues (a recommended refactor, a method that does not do what its name and comment claim, one that is misdocumented), strongest first, up to --budget methods; with a path, only the methods in that file or directory. For each one an OpenAI model sees the method with its comment, the context the hunt used, and what the hunt found wrong, and returns a rewrite of that region: the method, its comment, and any helpers split out beside it. The rewrite must parse and must not make the file deeper, more complex, or riskier. Every test that reaches the method (or the whole suite, when none does) must still pass. System One then reads the rewrite with the same neighborhood: each issue must look less likely than before, the method no more defective, and, comparing the two versions, behavior unchanged. A rewrite that passes is committed on the current branch with the summary as its message; a rejected attempt leaves the checkout as it was. Three attempts, each fed the previous rejection. Refuses to run on main or master. A finding id in place of the path works one method. Needs OPENAI_API_KEY and TYPESAFE_API_KEY.' },
  publish: { args: '<finding-id>', summary: 'File one finding on GitHub: an issue, a pull request for its proven fix, or a closed issue for a discarded one', detail: 'Publishes whatever the finding has become, with the gh CLI. First the OpenAI model writes the finding up from the code the way an engineer files a bug: what happens, how to reproduce it, what should happen, and, once fixed, what the change does. Without a fix, that becomes an issue; an issue already carrying the finding\'s marker is updated, never duplicated. With a fix that perch fix proved, it files or updates the issue, builds a branch perch/fix-<id> from the finding\'s commit carrying the patch and its regression test, pushes it to origin, and opens a pull request that closes the issue. With a fix that was discarded after every attempt failed to prove it, it closes the open issue with the last rejection as the reason. Needs OPENAI_API_KEY when a write-up has to be produced.' },
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
${column([['TYPESAFE_API_KEY', `Required by hunt and fix, which always use the ${DEFAULT_SYSTEM_ONE_MODEL} model to question code`], ['OPENAI_API_KEY', 'Required by fix, which uses an OpenAI model to write the patch and test'], ['OPENAI_BASE_URL', 'OpenAI-compatible endpoint. Defaults to https://api.openai.com/v1'], ['OPENAI_MODEL', `OpenAI model for fix. Defaults to ${DEFAULT_MODEL}`]])}

Examples:
${column([['perch scan', 'The riskiest files, with overall scores'], ['perch hunt --budget 40', 'Question forty methods, riskiest first'], ['perch issues', 'Open issues: defects, refactors, misaligned and misdocumented methods'], ['perch issues 3f9c2a', 'Everything the model answered about one method'], ['perch fix --budget 5', 'Fix five open defects, one commit each'], ['perch refactor src/metrics.ts', 'Improve the methods with design issues in one file'], ['perch publish 3f9c2a', 'File it on GitHub: an issue, and a pull request once it is fixed'], ['perch fix --help', 'Details for one command']])}`;

function usageFor(name) {
  const help = commandHelp[name];
  const own = Object.values(options).filter(([, , verbs]) => verbs.includes(name));
  return `perch ${name}: ${help.summary}

Usage: perch ${name} ${help.args ? `${help.args} ` : ''}[options]

${wrap(help.detail)}

Options:
${column(own.map(([flag, text]) => [flag, text]))}`;
}

const valued = new Set(['paths', 'budget', 'parallel', 'min', 'model', 'out']);
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
const modelFrom = ({ flags, env, log }) => createModel({ apiKey: env.OPENAI_API_KEY, model: flags.model || env.OPENAI_MODEL || DEFAULT_MODEL, baseUrl: env.OPENAI_BASE_URL || undefined, log });
const storeFrom = async flags => openStore(await resolveOut(flags.out));
const findingRef = (name, argument) => { if (!argument) throw new UsageError(`${name} needs a finding id from perch issues`); return argument; };
const threshold = value => { const min = value === undefined ? 50 : Number(value); if (!(min >= 0 && min <= 100)) throw new UsageError('--min must be a percentage from 0 to 100'); return min; };
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

/** `perch fix` and `perch refactor`: work the open findings of one kind in the checkout the last hunt ran in, optionally under one path or for one finding. */
async function work(io, kind) {
  const budget = positiveInteger('--budget', io.flags.budget, DEFAULT_BUDGET);
  const min = threshold(io.flags.min);
  const model = modelFrom(io);
  const systemOne = createSystemOne({ apiKey: io.env.TYPESAFE_API_KEY, log: io.log });
  const store = await storeFrom(io.flags);
  const root = (await store.latestHunt())?.root;
  const shell = createShell({ verbose: io.verbose, log: io.debug });
  const run = kind === 'refactor' ? runRefactor : runFix;
  const shared = { out: store.out, model, systemOne, shell, analyzer: createSourceAnalyzer(), log: io.log };
  if (io.argument && looksLikeId(io.argument)) {
    const finding = await store.findFinding(io.argument);
    const findingRoot = finding.root ?? root;
    if (!findingRoot) throw new Error(`finding ${finding.id} has no repository recorded; hunt again`);
    const record = await run({ finding, root: findingRoot, ...shared });
    print(io, record, formatFix(record));
    return;
  }
  const findings = underPath(kind === 'refactor' ? await store.designFindings(min / 100) : await store.findings(min / 100), io.argument);
  if (io.argument && !findings.length) throw new Error(`no open ${kind === 'refactor' ? 'design issues' : 'defects'} under ${io.argument}; perch issues lists what the hunt found`);
  const items = counter(io, kind === 'refactor' ? 'refactored methods' : 'investigated defects');
  let batch;
  try { batch = await runFixQueue({ findings, budget, kind, run, root, progress: items.update, ...shared }); }
  finally { items.clear(); }
  print(io, batch, formatFixes(batch));
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
  fix: io => work(io, 'fix'),
  refactor: io => work(io, 'refactor'),
  async publish(io) {
    const ref = findingRef('publish', io.argument);
    const store = await storeFrom(io.flags);
    const finding = await store.findFinding(ref);
    const latest = await store.latestHunt();
    const github = finding.github ?? latest?.github ?? null;
    const published = await publishFinding({ finding, github, root: finding.root ?? latest?.root ?? null, out: store.out, model: () => modelFrom(io), analyzer: createSourceAnalyzer(), log: io.log });
    if (published !== finding) await store.appendEvent({ type: 'published', at: new Date().toISOString(), id: finding.id, method: finding.method, github_url: published.github_url ?? null, github_status: published.github_status ?? null, pr_url: published.pr_url ?? null, pr_status: published.pr_status ?? null, description: published.description ?? null });
    print(io, published, formatPublished(published));
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
    const findings = await store.issues(min / 100);
    const closed = Boolean(io.flags.closed);
    print(io, visibleFindings(findings, { closed }), formatIssues(findings, min / 100, shown(io), { closed }));
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
