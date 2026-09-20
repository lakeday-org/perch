/** Live CLI acceptance tests. Each application gets its own disposable git repository and real Jev requests. */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const cli = join(workspace, 'bin/perch.mjs');
if (!process.env.PERCH_API_KEY && !process.env.TYPESAFE_API_KEY) throw new Error('Export PERCH_API_KEY before running the live fixture checks.');
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'perch-fixtures-')));
const artifacts = join(workspace, '.perch', 'fixture-verification');
await mkdir(artifacts, { recursive: true });
const report = { scratch, started_at: new Date().toISOString(), applications: [], commands: [] };
const save = () => writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const git = (root, args) => promisify(execFile)('git', args, { cwd: root });

const apps = [
  { id: 'python', directory: 'order-service', file: 'checkout.py', name: 'can_fulfil', methods: 14 },
  { id: 'typescript', file: 'src/inventory.ts', name: 'canFulfil', methods: 3 },
  { id: 'frontend', file: 'src/CheckoutPanel.tsx', name: 'canCheckout', methods: 3 },
  { id: 'rust', file: 'src/inventory.rs', name: 'can_fulfil', methods: 4 },
  { id: 'java', file: 'src/example/Inventory.java', name: 'Inventory.canFulfil', methods: 4 },
  { id: 'cpp', file: 'src/checkout.cpp', name: 'can_fulfil', methods: 4 },
];

async function command(root, label, args, allowed = [0]) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: process.env });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data);
  child.stderr.on('data', data => stderr += data);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await writeFile(join(artifacts, `${label}.stdout`), stdout);
  await writeFile(join(artifacts, `${label}.stderr`), stderr);
  report.commands.push({ label, args, code, ok: allowed.includes(code) });
  await save();
  assert(allowed.includes(code), `${label}: exit ${code}: ${stderr.slice(-1200)}`);
  return args.includes('--json') ? JSON.parse(stdout) : stdout;
}

/** Correct the seeded any-item/every-item mistake in the temporary copy, leaving the committed fixture buggy. */
function corrected(app, source) {
  if (app.id === 'python') return source.replace(
    'if stock.get(item.sku, 0) >= item.quantity:\n            return True\n    return False',
    'if stock.get(item.sku, 0) < item.quantity:\n            return False\n    return True');
  if (['typescript', 'frontend'].includes(app.id)) return source.replace(
    'if ((stock[item.sku] ?? 0) >= item.quantity) return true;\n  }\n  return false;',
    'if ((stock[item.sku] ?? 0) < item.quantity) return false;\n  }\n  return true;');
  if (app.id === 'rust') return source.replace(
    'if stock.get(item.sku).copied().unwrap_or(0) >= item.quantity {\n            return true;\n        }\n    }\n    return false;',
    'if stock.get(item.sku).copied().unwrap_or(0) < item.quantity {\n            return false;\n        }\n    }\n    return true;');
  if (app.id === 'java') return source.replace(
    'if (stock.getOrDefault(item.sku(), 0) >= item.quantity()) return true;\n        }\n        return false;',
    'if (stock.getOrDefault(item.sku(), 0) < item.quantity()) return false;\n        }\n        return true;');
  assert.equal(app.id, 'cpp');
  return source.replace(
    'if (found != stock.end() && found->second >= item.quantity) return true;\n    }\n    return false;',
    'if (found == stock.end() || found->second < item.quantity) return false;\n    }\n    return true;');
}

for (const app of apps) {
  const root = join(scratch, app.id);
  await cp(join(workspace, 'test', 'fixtures', app.directory ?? `order-service-${app.id}`), root, {
    recursive: true, filter: source => !['node_modules', 'dist', 'target', 'out', '.git', '.perch'].includes(basename(source)),
  });
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture verification'],
    ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-qm', 'Order-service fixture']]) await git(root, args);
  const call = (name, args, allowed) => command(root, `${app.id}-${name}`, args, allowed);
  const scan = await call('scan', ['scan', '--json', '--verbose'], [3]);
  assert.equal(scan.run.status, 'complete');
  assert.equal(scan.run.methods, app.methods);
  assert.equal(scan.run.visited.length, app.methods);
  assert.deepEqual(scan.run.failed, []);
  const debug = await readFile(join(artifacts, `${app.id}-scan.stderr`), 'utf8');
  assert.match(debug, /\[perch\] analyzed /);
  assert.match(debug, /\[perch\] asking /);
  const original = scan.issues.find(issue => issue.path === app.file && issue.name === app.name);
  assert(original, `${app.id}: scan did not find the planted defect`);
  const again = await call('cached-scan', ['scan', '--json'], [3]);
  assert.equal(again.run.calls, 0);
  assert.equal(again.run.carried, app.methods);
  const details = await call('detail', ['issues', original.id, '--json', '--verbose']);
  assert.equal(details.name, app.name);
  await call('check-method', ['check', `${app.file}::${app.name}`, '--rules', 'defect', '--json'], [3]);
  await call('check-issue', ['check', original.id, '--rules', 'defect', '--json'], [3]);
  const bugs = await call('filtered-issues', ['issues', '--filter', 'type=defect', '--all', '--json']);
  assert(bugs.some(issue => issue.id === original.id));
  const scoped = await call('scoped-scan', ['scan', '--paths', app.file, '--filter', 'type=defect', '--json'], [3]);
  assert(scoped.run.visited.length > 0);
  assert(scoped.run.visited.every(method => method.path === app.file));
  await call('close', ['close', original.id, '--reason', 'Fixture workflow verification', '--json']);
  const closed = await call('closed-issues', ['issues', '--closed', '--all', '--json']);
  assert(closed.some(issue => issue.id === original.id));
  const open = await call('open-issues', ['issues', '--all', '--json']);
  assert(!open.some(issue => issue.id === original.id));
  await call('reopen', ['reopen', original.id, '--json']);
  const reopened = await call('reopened-issues', ['issues', '--all', '--json']);
  assert(reopened.some(issue => issue.id === original.id));

  const name = app.name.split('.').at(-1);
  const rule = `If the method is named ${name}, it returns true only when every requested item has enough stock. Returning true after checking just one available item breaks this rule. Methods with other names satisfy this rule.`;
  await call('rule-add', ['rules', 'add', 'fixture-availability', '--where', app.file, '--each', 'method', '--ensure', rule]);
  await call('rule-edit', ['rules', 'edit', 'fixture-availability', '--min', '60']);
  let listed = await call('rules-list', ['rules', 'list', '--json']);
  assert(listed.some(rule => rule.name === 'fixture-availability'));
  const failed = await call('check-broken', ['check', `${app.file}::${app.name}`, '--rules', 'fixture-availability', '--json', '--verbose'], [3]);
  assert.equal(failed.checked, 1);
  assert.equal(failed.broken.length, 1);
  const ruleScan = await call('rule-scan', ['scan', '--filter', 'rule=fixture-availability', '--json'], [3]);
  assert(ruleScan.issues.some(issue => issue.path === app.file));
  await call('file-rule-add', ['rules', 'add', 'fixture-file-availability', '--where', app.file,
    '--ensure', `Read only ${name}. It must reject an order containing an unavailable item even when another requested item is available. Accepting that mixed order breaks this rule.`]);
  const badFile = await call('file-check-broken', ['check', app.file, '--rules', 'fixture-file-availability', '--json'], [3]);
  assert.equal(badFile.checked, 1);

  const file = join(root, app.file), body = await readFile(file, 'utf8'), fixed = corrected(app, body);
  assert.notEqual(fixed, body, 'The control must actually correct the defect');
  await writeFile(file, fixed);
  const passed = await call('check-fixed', ['check', `${app.file}::${app.name}`, '--rules', 'fixture-availability', '--json', '--verbose']);
  assert.equal(passed.checked, 1);
  assert.equal(passed.clean, true);
  const goodFile = await call('file-check-fixed', ['check', app.file, '--rules', 'fixture-file-availability', '--json']);
  assert.equal(goodFile.checked, 1);
  assert.equal(goodFile.clean, true);
  await git(root, ['add', app.file]);
  await git(root, ['commit', '-qm', 'Require stock for every item']);
  const changed = await call('changed-scan', ['scan', '--since', 'HEAD~1', '--filter', 'rule=fixture-availability', '--json']);
  assert.equal(changed.run.status, 'complete');
  assert(changed.run.visited.length > 0);
  assert(changed.run.visited.every(method => method.path === app.file));
  assert.deepEqual(changed.run.broken, []);
  await call('rule-remove', ['rules', 'remove', 'fixture-availability']);
  await call('file-rule-remove', ['rules', 'remove', 'fixture-file-availability']);
  listed = await call('rules-list-after', ['rules', 'list', '--json']);
  assert(!listed.some(rule => rule.name.startsWith('fixture-')));
  const doctor = await call('doctor', ['doctor', '--json']);
  assert(doctor.checks.every(check => check.ok));
  await call('setup', ['setup', 'codex', '--json']);
  report.applications.push({ app: app.id, methods: app.methods, edges: scan.run.edges,
    findings: scan.issues.map(issue => `${issue.path}::${issue.name}`).sort(),
    broken_probability: failed.broken[0].broken, uncommitted_fix_passed: true });
  await save();
  console.log(`${app.id}: ${app.methods} methods; scan, rules, debug, fix, cache, scope, reporting and setup passed`);
}
report.completed_at = new Date().toISOString();
await save();
console.log(`Verification report: ${join(artifacts, 'report.json')}`);
