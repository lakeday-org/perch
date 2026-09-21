"""Resume an existing VLoc experiment without changing its baseline CLI or scoring code."""
import argparse
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time


class Stopped(RuntimeError):
    pass


def snapshot_key(row, phase):
    prefix = 'vulnerable' if phase == 'before' else 'merge'
    return row['repo_full_name'], row[prefix + '_content_md5']


def blocked(directory):
    log = directory / 'stderr.log'
    return log.exists() and any(value in log.read_text(errors='replace') for value in
                                ('HTTP 401', 'HTTP 402', 'HTTP 403', 'Benchmark transport stopped'))


def saved_answers(paths):
    """Only completed readings with exact Perch cache keys can be carried into a retry."""
    answers = {}
    for path in sorted(paths, key=lambda path: path.stat().st_mtime):
        run = json.loads(path.read_text())
        for event in run.get('visited', []):
            if event.get('status') in ('read', 'carried') and event.get('key') and event.get('answers_set'):
                answers[event['method']] = {key: value for key, value in event.items() if key != 'status'}
    return list(answers.values())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--budget-usd', type=float, default=90)
    args = parser.parse_args(argv)
    args.baseline = args.baseline.resolve()
    sys.path.insert(0, str(args.baseline / 'benchmarks/vloc'))
    import benchmark as bench
    root = bench.DEFAULT_CACHE / 'results' / args.name
    if not root.is_dir():
        raise ValueError('The baseline experiment must already exist')
    with (bench.DEFAULT_CACHE / 'runner.lock').open('a+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Stopped('Another benchmark runner or scanner still holds the lock')
        lock.seek(0); lock.truncate(); lock.write(str(os.getpid())); lock.flush()
        return resume(bench, args, root, lock.fileno())


def resume(bench, args, root, lock_fd):
    rows = bench.manifest(bench.DEFAULT_CACHE)
    metadata = json.loads((root / 'experiment.json').read_text())
    rows = [row for row in rows if row['alpha_id'] in metadata['case_ids']]
    cache = root / 'transport-cache'
    cache.mkdir(exist_ok=True)
    if (cache / 'STOP.json').exists():
        raise Stopped('Transport is paused; review STOP.json before authorizing a restart')
    if not (cache / 'budget.json').exists():
        bench.write_json(cache / 'budget.json', {'limit_usd': args.budget_usd, 'spent_usd': 0})
    guard = Path(__file__).with_name('fetch-cache.mjs').resolve()
    controller_hash = hashlib.sha256(Path(__file__).read_bytes() + guard.read_bytes()).hexdigest()
    bench.write_json(root / 'recovery-controller.json', {
        'sha256': controller_hash, 'baseline_harness_sha256': metadata['harness_sha256'],
        'started_at': time.time(), 'pid': os.getpid(), 'budget_usd': args.budget_usd,
        'behavior': 'exact request cache; saved method recovery; identical snapshot reuse; exclusive lock; access-error stop',
    })
    groups, available = {}, {}
    for row in rows:
        for phase in bench.PHASES:
            key = snapshot_key(row, phase)
            groups.setdefault(key, []).append((row, phase))
            directory = root / row['alpha_id'] / phase
            result = directory / 'result.json'
            if result.exists():
                value = json.loads(result.read_text())
                if value['status'] in ('complete', 'incomplete', 'unscanned') and not value.get('reused_from'):
                    available.setdefault(key, directory)
                elif value['status'] == 'error' and blocked(directory):
                    directory.rename(directory.with_name(phase + '.blocked-' + str(time.time_ns())))
    group_locks = {key: threading.Lock() for key in groups}
    local = threading.local()
    original_phase, original_run = bench.run_phase, bench.subprocess.run

    def run(command, **kwargs):
        if len(command) > 1 and command[1] == str(args.baseline / 'bin/perch.mjs'):
            out = Path(command[command.index('--out') + 1])
            out.mkdir(parents=True, exist_ok=True)
            recovered = saved_answers(local.recovery)
            with (out / 'scan.jsonl').open('w') as stream:
                for event in recovered:
                    stream.write(json.dumps(event) + '\n')
            bench.write_json(out.parent / 'recovery.json', {'saved_methods': len(recovered), 'sources': [str(path) for path in local.recovery]})
            env = dict(kwargs['env'])
            env['VLOC_TRANSPORT_CACHE'] = str(cache)
            env['NODE_OPTIONS'] = (env.get('NODE_OPTIONS', '') + ' --import=' + guard.as_uri()).strip()
            kwargs.update(env=env, pass_fds=(lock_fd,))
        return original_run(command, **kwargs)

    def phase(row, phase, options, directory, rules):
        if (cache / 'STOP.json').exists():
            raise Stopped((cache / 'STOP.json').read_text())
        key = snapshot_key(row, phase)
        with group_locks[key]:
            if (cache / 'STOP.json').exists():
                raise Stopped((cache / 'STOP.json').read_text())
            target = directory / row['alpha_id'] / phase
            if key in available:
                source = available[key]
                result = copy.deepcopy(json.loads((source / 'result.json').read_text()))
                expected = bench.ground_truth(row)
                result.update(id=row['alpha_id'], phase=phase, cwes=json.loads(row['cwes']), cves=json.loads(row['cves']),
                              ground_truth_files=expected, usage={}, seconds=0, reused_from=str(source.relative_to(root)))
                visits = saved_answers(list((source / 'store/runs').glob('*/run.json')))
                result['ground_truth_files_visited'] = sorted(set(expected) & {event['path'] for event in visits})
                result.pop('no_post_fix_alerts', None)
                if result['status'] == 'complete':
                    result['localization'] = bench.file_scores(result['predicted_files'], expected)
                    if phase == 'after': result['no_post_fix_alerts'] = not result['predicted_files']
                bench.write_json(target / 'result.json', result)
                return result
            local.recovery = []
            for source_row, source_phase in groups[key]:
                case = root / source_row['alpha_id']
                for previous in case.glob(source_phase + '*'):
                    local.recovery.extend((previous / 'store/runs').glob('*/run.json'))
            result = original_phase(row, phase, options, directory, rules)
            if result['status'] in ('complete', 'incomplete', 'unscanned'):
                available[key] = target
            if (cache / 'STOP.json').exists():
                raise Stopped((cache / 'STOP.json').read_text())
            return result

    bench.run_phase, bench.subprocess.run = phase, run
    try:
        return bench.main(['run', '--name', args.name, '--jobs', str(metadata['jobs']), '--resume'])
    finally:
        bench.run_phase, bench.subprocess.run = original_phase, original_run
        results = []
        for row in rows:
            for phase in bench.PHASES:
                result = root / row['alpha_id'] / phase / 'result.json'
                if result.exists(): results.append(json.loads(result.read_text()))
        bench.write_json(root / 'summary.json', bench.summarize(results, metadata['case_ids']))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, Stopped) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
