/** perch command line: `perch scan` and `perch report`. */
import { join } from 'node:path';
import { revision as gitRevision } from './git.js';
import { resolveTarget } from './target.js';
import { createModel, DEFAULT_MODEL } from './model.js';
import { createShell } from './shell.js';
import { createSourceAnalyzer } from './analysis.js';
import { runScan } from './scan.js';
import { formatSummary, latestScan } from './report.js';
import { publishIssues } from './issues.js';

const usage = `usage:
  perch scan [<target>] [--fix] [--issues] [--paths a,b] [--candidates N] [--model M] [--out DIR] [--keep-workspace] [--json] [--verbose]
  perch report [<target>] [--out DIR] [--json]

<target> is a local directory (default ".", resolved to its git root) or a GitHub
repository given as owner/repo or https://github.com/owner/repo.

Environment: OPENAI_API_KEY (required for scan), PERCH_MODEL (default ${DEFAULT_MODEL}), OPENAI_BASE_URL (optional).`;

const valued = new Set(['paths', 'candidates', 'model', 'out']);

export function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    if (valued.has(key)) {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new Error(`--${key} requires a value`);
      flags[key] = value;
    } else if (['fix', 'issues', 'keep-workspace', 'json', 'verbose', 'help'].includes(key)) flags[key] = true;
    else throw new Error(`unknown option --${key}`);
  }
  return { flags, positional };
}

export async function main(argv, { stdout = text => process.stdout.write(text + '\n'), stderr = text => process.stderr.write(text + '\n'), env = process.env } = {}) {
  let parsed;
  try { parsed = parseArgs(argv); }
  catch (error) { stderr(`perch: ${error.message}\n${usage}`); return 2; }
  const { flags, positional } = parsed;
  const [commandName = 'help', target = '.'] = positional;
  if (flags.help || commandName === 'help') { stdout(usage); return 0; }
  const verbose = Boolean(flags.verbose);
  const log = message => { if (verbose || !flags.json) stderr(`[perch] ${message}`); };
  try {
    if (commandName === 'report') {
      const resolved = await resolveTarget(target, { out: flags.out, log });
      const scan = await latestScan(resolved.out);
      if (!scan) { stderr(`perch: no scans found under ${join(resolved.out, 'scans')}`); return 1; }
      stdout(flags.json ? JSON.stringify(scan, null, 2) : formatSummary(scan));
      return 0;
    }
    if (commandName !== 'scan') { stderr(`perch: unknown command ${commandName}\n${usage}`); return 2; }

    const model = createModel({ apiKey: env.OPENAI_API_KEY, model: flags.model || env.PERCH_MODEL || DEFAULT_MODEL, baseUrl: env.OPENAI_BASE_URL || undefined, log });
    const candidates = flags.candidates === undefined ? 4 : Number(flags.candidates);
    if (!Number.isInteger(candidates) || candidates < 1) throw new Error('--candidates must be a positive integer');
    const paths = flags.paths ? flags.paths.split(',').map(path => path.trim()).filter(Boolean) : [];
    const resolved = await resolveTarget(target, { out: flags.out, log });
    const revision = await gitRevision(resolved.root);
    const scan = await runScan({
      root: resolved.root, revision, label: resolved.label, github: resolved.github, out: resolved.out, model, analyzer: createSourceAnalyzer(),
      shell: createShell({ verbose, log: stderr }), fix: Boolean(flags.fix), paths, candidates, keepWorkspace: Boolean(flags['keep-workspace']), log,
    });
    if (flags.issues && scan.issues.length) {
      if (!resolved.github) stderr('perch: --issues needs a GitHub target or a github.com origin; skipping issue creation');
      else await publishIssues({ github: resolved.github, issues: scan.issues, issuesPath: join(scan.out, 'issues.json'), log });
    }
    stdout(flags.json ? JSON.stringify(scan, null, 2) : formatSummary(scan));
    return 0;
  } catch (error) {
    stderr(`perch: ${error.message}`);
    if (verbose && error.stack) stderr(error.stack);
    return 1;
  }
}
