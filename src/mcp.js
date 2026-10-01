/**
 * `perch mcp`: a Model Context Protocol server on stdin and stdout, so a coding assistant can read what Perch Cloud's CI scans
 * found without anyone pasting it in. It answers with the login perch already has: `perch login` on a laptop, or a CI token.
 *
 * Messages are JSON-RPC, one per line, as MCP's stdio transport has them. Nothing but protocol goes to stdout; anything else
 * would be read as a message.
 */
import { createInterface } from 'node:readline';
import { CLOUD_ORIGIN, cloudRequest, readCloudLogin, sessionToken } from './cloud-auth.js';
import { remoteRepositoryName } from './cloud-client.js';
import { git } from './git.js';

const PROTOCOL_VERSION = '2025-06-18';

export const TOOLS = [
  {
    name: 'perch_scans',
    title: 'Perch CI scans',
    description: 'Recent Perch Cloud CI scans of this repository, newest first: each scan\'s id, pull request or branch, commit, '
      + 'result and issue counts. By default only scans of the checked-out branch. Pass a scan id to perch_scan for its issues.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Scans of this branch. Defaults to the checked-out branch.' },
        pull_request: { type: 'integer', description: 'Scans of this pull request number, on any branch.' },
        all_branches: { type: 'boolean', description: 'Scans of every branch and pull request.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'perch_scan',
    title: 'Perch CI scan issues',
    description: 'One Perch Cloud CI scan and every issue it reported: the method, file and line, type, kind, severity and the '
      + 'probability behind it, and the perch check command that asks about that method again after a fix.',
    inputSchema: {
      type: 'object',
      properties: { scan_id: { type: 'string', description: 'A scan id from perch_scans, or from a scan link in the dashboard.' } },
      required: ['scan_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

/** A CI token names its own workspace and repository; a login names its workspace, and the git remote names the repository. */
async function credentials(env, fetchImpl) {
  if (env.PERCH_API_KEY) return { getToken: async () => env.PERCH_API_KEY, organizationId: env.PERCH_ORGANIZATION || null };
  const saved = await readCloudLogin(env);
  if (!saved) throw new Error('Not signed in to Perch Cloud. Run perch login in a terminal, then try again.');
  return { getToken: signal => sessionToken(env, fetchImpl, signal), organizationId: env.PERCH_ORGANIZATION || saved.organizationId };
}

async function repositoryName(root) {
  const remote = await git(['config', '--get', 'remote.origin.url'], root).catch(() => '');
  return remoteRepositoryName(remote);
}

async function currentBranch(root) {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root).then(out => out.trim(), () => '');
  return branch && branch !== 'HEAD' ? branch : null;
}

/** perch check takes a method as path::name; the Cloud stores it that way, or as the bare name beside its path. */
const methodTarget = finding => finding.method.includes('::') ? finding.method : `${finding.path}::${finding.method}`;

/** The two tools, against the Cloud. Split from the transport so tests call them directly. */
export function createTools({ env, root, fetchImpl = globalThis.fetch }) {
  const get = async (path, query) => {
    const { getToken, organizationId } = await credentials(env, fetchImpl);
    const params = new URLSearchParams(Object.entries({ ...query, ...(organizationId ? { organizationId } : {}) })
      .filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return cloudRequest(fetchImpl, `${CLOUD_ORIGIN}${path}?${params}`, { headers: { authorization: `Bearer ${await getToken()}` } }, 30000);
  };
  return {
    async perch_scans({ branch, pull_request: pullRequest, all_branches: allBranches } = {}) {
      const repository = env.PERCH_API_KEY ? null : await repositoryName(root);
      if (!env.PERCH_API_KEY && !repository) throw new Error('This directory has no git remote that names a repository, so there are no CI scans to read.');
      const onBranch = allBranches || pullRequest ? null : branch || await currentBranch(root);
      const { scans } = await get('/v1/scans/recent', { repository, branch: onBranch, pullRequest });
      return {
        repository, branch: onBranch, pull_request: pullRequest ?? null,
        scans: scans.map(scan => ({
          id: scan.id, url: scan.url, pull_request: scan.pull_request, branch: scan.branch, commit: scan.revision,
          scope: scan.scope === 'full' ? 'whole repository' : 'changes only', finished_at: new Date(scan.finished_at).toISOString(),
          result: scan.exit_code === 1 ? 'failed' : scan.open_issues ? 'issues' : 'clean', error: scan.error || undefined,
          issues: scan.open_issues, security: scan.security, defect: scan.defect, lint: scan.lint, refactor: scan.refactor, docs: scan.docs,
          methods: scan.methods, perch_version: scan.perch_version || undefined,
        })),
        ...(scans.length ? {} : { note: onBranch ? `No CI scans of ${onBranch} yet. all_branches: true lists every branch.` : 'No CI scans yet.' }),
      };
    },
    async perch_scan({ scan_id: scanId } = {}) {
      if (typeof scanId !== 'string' || !scanId.trim()) throw new Error('scan_id is required.');
      const { scan, findings, url } = await get('/v1/scans/detail', { scanId: scanId.trim() });
      return {
        id: scan.id, url, pull_request: scan.pull_request, branch: scan.branch, commit: scan.revision,
        result: scan.exit_code === 1 ? 'failed' : scan.open_issues ? 'issues' : 'clean', error: scan.error || undefined,
        issues: findings.map(finding => ({
          id: finding.id, method: methodTarget(finding), path: finding.path, line: finding.line, type: finding.type,
          kind: finding.kind, severity: finding.severity, probability: finding.probability, check: `perch check ${methodTarget(finding)}`,
        })),
        reading: 'Each issue is a probability, not a located defect. Read the method before changing it, fix what is real, '
          + 'run the check command until it exits 0, and leave code that is right as it is.',
      };
    },
  };
}

/** Answers one JSON-RPC message, or returns null for a notification, which has no answer. */
export async function handleMessage(message, tools, version) {
  const { id, method, params } = message;
  const reply = result => ({ jsonrpc: '2.0', id, result });
  const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  if (id === undefined || id === null) return null;
  if (method === 'initialize') {
    return reply({ protocolVersion: params?.protocolVersion || PROTOCOL_VERSION, capabilities: { tools: {} },
      serverInfo: { name: 'perch', title: 'Perch', version },
      instructions: 'Read what Perch Cloud CI scans found in this repository. perch_scans lists them; perch_scan gives one scan\'s issues.' });
  }
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: TOOLS });
  if (method === 'tools/call') {
    const tool = tools[params?.name];
    if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
    // A tool that fails says why as its result, so the assistant reads the reason rather than a protocol error.
    try { return reply({ content: [{ type: 'text', text: JSON.stringify(await tool(params.arguments ?? {}), null, 2) }] }); }
    catch (error) { return reply({ content: [{ type: 'text', text: error.message }], isError: true }); }
  }
  return fail(-32601, `Method not found: ${method}`);
}

/** Reads messages from input until it closes, answering each on output. Requests run concurrently; each answer names its id. */
export function serveMcp({ env, root, version, input = process.stdin, output = process.stdout, fetchImpl = globalThis.fetch }) {
  const tools = createTools({ env, root, fetchImpl });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  const send = message => output.write(`${JSON.stringify(message)}\n`);
  lines.on('line', line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    const work = handleMessage(message, tools, version).then(answer => { if (answer) send(answer); })
      .catch(error => send({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: error.message } }))
      .finally(() => pending.delete(work));
    pending.add(work);
  });
  return new Promise(resolve => lines.on('close', () => Promise.allSettled(pending).then(resolve)));
}
