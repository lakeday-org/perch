import json
import fcntl
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from safe_resume import main, saved_answers, snapshot_key, Stopped


class RecoveryTests(unittest.TestCase):
    def test_scanner_child_keeps_exclusive_lock_after_parent_closes_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'results/test').mkdir(parents=True)
            held = (root / 'runner.lock').open('a+')
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            child = subprocess.Popen(['python3', '-c', 'import time; time.sleep(30)'], pass_fds=(held.fileno(),))
            held.close()
            try:
                with patch.dict('sys.modules', {'benchmark': SimpleNamespace(DEFAULT_CACHE=root)}):
                    with self.assertRaisesRegex(Stopped, 'Another benchmark runner'):
                        main(['--baseline', str(root), '--name', 'test'])
            finally:
                child.terminate(); child.wait(timeout=5)

    def test_saved_answers_exclude_failures_and_keep_latest_completed_reading(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = []
            for index, events in enumerate([
                [{'method': 'f', 'key': 'old', 'answers_set': True, 'status': 'read'},
                 {'method': 'g', 'key': 'good', 'answers_set': True, 'status': 'read'}],
                [{'method': 'f', 'key': 'new', 'answers_set': True, 'status': 'carried'},
                 {'method': 'g', 'key': 'bad', 'answers_set': True, 'status': 'failed'}],
            ]):
                path = root / str(index); path.write_text(json.dumps({'visited': events})); paths.append(path)
            result = {event['method']: event for event in saved_answers(paths)}
            self.assertEqual(result['f']['key'], 'new')
            self.assertEqual(result['g']['key'], 'good')
            self.assertNotIn('status', result['f'])

    def test_snapshot_reuse_requires_same_repository_and_content(self):
        row = {'repo_full_name': 'one/repo', 'vulnerable_content_md5': 'a', 'merge_content_md5': 'b'}
        self.assertNotEqual(snapshot_key(row, 'before'), snapshot_key(row, 'after'))
        self.assertEqual(snapshot_key(row, 'before'), snapshot_key(dict(row, merge_content_md5='a'), 'after'))
        self.assertNotEqual(snapshot_key(row, 'before'), snapshot_key(dict(row, repo_full_name='other/repo'), 'before'))


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'budget.json').write_text(json.dumps({'limit_usd': 1, 'spent_usd': 0}))
        self.script = self.root / 'client.mjs'
        self.script.write_text('''import {appendFileSync} from 'node:fs';
globalThis.fetch = async () => {
  appendFileSync(process.env.VLOC_TRANSPORT_CACHE + '/sent', 'request\\n');
  await new Promise(resolve => setTimeout(resolve, 80));
  if (process.env.MODE === 'unknown') throw new Error('connection lost');
  return new Response(JSON.stringify({model:'jev-1.13.0',answers:{x:{noul:0.9}},usage:{input_tokens:100,output_tokens:10}}), {status:Number(process.env.STATUS || 200)});
};
await import(process.env.GUARD);
const response = await fetch('https://api.typesafe.ai/v1/systemone',{body:'{"model":"jev-latest","questions":{"x":{}}}'});
console.log(JSON.stringify(await response.json()));
''')
        self.env = dict(os.environ, VLOC_TRANSPORT_CACHE=str(self.root),
                        GUARD=Path(__file__).with_name('fetch-cache.mjs').resolve().as_uri())

    def client(self, **env):
        return subprocess.Popen(['node', str(self.script)], env=dict(self.env, **env), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def test_two_processes_share_one_request_and_cached_usage_is_zero(self):
        a, b = self.client(), self.client()
        values = []
        for process in (a, b):
            out, error = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, error)
            values.append(json.loads(out))
        self.assertEqual((self.root / 'sent').read_text().splitlines(), ['request'])
        self.assertEqual(sorted(value['usage']['input_tokens'] for value in values), [0, 100])
        self.assertTrue(all(value['answers']['x']['noul'] == 0.9 for value in values))

    def test_billing_failure_stops_every_subsequent_request(self):
        first = self.client(STATUS='402'); first.communicate(timeout=10)
        self.assertTrue((self.root / 'STOP.json').exists())
        second = self.client(); second.communicate(timeout=10)
        self.assertNotEqual(second.returncode, 0)
        self.assertEqual((self.root / 'sent').read_text().splitlines(), ['request'])

    def test_unknown_outcome_is_never_blindly_retried(self):
        first = self.client(MODE='unknown'); first.communicate(timeout=10)
        self.assertNotEqual(first.returncode, 0)
        second = self.client(); second.communicate(timeout=10)
        self.assertNotEqual(second.returncode, 0)
        self.assertEqual((self.root / 'sent').read_text().splitlines(), ['request'])
        self.assertEqual(json.loads((self.root / 'STOP.json').read_text())['reason'], 'uncertain_request')

    def test_budget_exhaustion_stops_before_network(self):
        (self.root / 'budget.json').write_text(json.dumps({'limit_usd': 1, 'spent_usd': 1}))
        process = self.client(); process.communicate(timeout=10)
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse((self.root / 'sent').exists())


if __name__ == '__main__':
    unittest.main()
