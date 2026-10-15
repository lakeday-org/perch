import { openStore } from './src/store.js';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function fuzz(v) {
  const temp = await mkdtemp(join(tmpdir(), 'perch-store-'));
  const out = join(temp, 'repo');
  const store = openStore(out);
  if (v.case === 'checkpoint_latest_run') {
    const save = await store.startRun(v.run);
    await save();
    await save(true);
    return await store.latestRun();
  }
  if (v.case === 'append_read_lines' || v.case === 'write_read_lines') {
    const path = join(out, 'rows.jsonl');
    const otherPath = join(out, 'other.jsonl');
    if (v.case === 'append_read_lines') {
      await store.appendLines(path, v.rows);
      await store.writeLines(otherPath, v.rows);
    } else {
      await store.writeLines(path, v.rows);
      await store.appendLines(otherPath, v.rows);
    }
    return { rows: await store.readLines(path), alternate: await store.readLines(otherPath) };
  }
  if (v.case === 'record_scan_indexes') {
    await store.recordScan(v.rows);
    const indexes = await store.indexes();
    return {
      rows: await store.readLines(store.scanPath),
      latest: [...indexes.latest.entries()],
      checks: [...indexes.checks.entries()],
      dismissals: [...indexes.dismissals.entries()]
    };
  }
  if (v.case === 'list_records') {
    await mkdir(join(out, 'runs', v.run.id), { recursive: true });
    await writeFile(join(out, 'runs', v.run.id, 'run.json'), JSON.stringify(v.run));
    await mkdir(join(out, 'scans', v.scan.revision), { recursive: true });
    await writeFile(join(out, 'scans', v.scan.revision, 'scan.json'), JSON.stringify(v.scan));
    return { runs: await store.listRuns(), scans: await store.listScans() };
  }
  if (v.case === 'exclude_boundary') {
    const boundaryRoot = join(temp, v.rootName);
    const boundaryOut = join(temp, v.rootName + v.suffix);
    await openStore(boundaryOut).exclude(boundaryRoot);
    const content = v.suffix === '/child' ? await readFile(join(boundaryOut, '.gitignore'), 'utf8') : null;
    return { content, suffix: v.suffix };
  }
  if (v.case === 'prune_directories') {
    for (const kind of ['runs', 'scans']) {
      await mkdir(join(out, kind, `keep_${v.id}`), { recursive: true });
      await mkdir(join(out, kind, `stale_${v.id}`), { recursive: true });
      await store.prune(kind, `keep_${v.id}`);
    }
    return {
      runs: (await readdir(join(out, 'runs'))).sort(),
      scans: (await readdir(join(out, 'scans'))).sort()
    };
  }
  if (v.case === 'symlink_prune') {
    const outside = join(temp, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'sentinel'), 'unchanged');
    await mkdir(join(out, 'runs'), { recursive: true });
    await mkdir(join(out, 'runs', `keep_${v.id}`), { recursive: true });
    await symlink(outside, join(out, 'runs', `stale_${v.id}`), 'dir');
    await store.prune('runs', `keep_${v.id}`);
    return {
      sentinel: await readFile(join(outside, 'sentinel'), 'utf8'),
      runs: (await readdir(join(out, 'runs'))).sort()
    };
  }
  if (v.case === 'start_log_tail') {
    const log = await store.startLog();
    await log(v.first);
    await log(v.last);
    return await store.tail(v.count);
  }
  if (v.case === 'read_missing_lines') return await store.readLines(join(out, 'missing.jsonl'));
  if (v.case === 'decide_closure') {
    const event = v.type === 'dismissed'
      ? await store.dismiss(v.finding, v.reason, v.kinds)
      : await store.reopen(v.finding, v.kinds);
    return { event, closures: [...(await store.closures()).entries()] };
  }
  if (v.case === 'query_scan_issues') {
    await mkdir(store.scanDir(v.id), { recursive: true });
    await writeFile(join(store.scanDir(v.id), 'scan.json'), JSON.stringify(v.scan));
    const latestScan = await store.latestScan();
    const issues = await store.issues(0.5, { scan: latestScan, all: true });
    return { latestScan, issues };
  }
  if (v.case === 'query_no_scan_issues') {
    await mkdir(join(out, 'scans'), { recursive: true });
    const issues = await store.issues(0.5, { scan: null, all: true });
    const findings = await store.findings(0.5);
    return { issues, findings };
  }
  if (v.case === 'find_finding_unique') {
    await store.recordScan([{ id: v.id, rule: 'lint_rule', broken: true, text: 'issue', said: 'issue' }]);
    return await store.findFinding(v.id);
  }
  if (v.case === 'with_source_lines_empty') {
    await mkdir(join(out, 'runs'), { recursive: true });
    return await store.withSourceLines([]);
  }
  throw new Error(`unknown case: ${v.case}`);
}