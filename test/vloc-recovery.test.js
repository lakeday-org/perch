import { execFileSync } from 'node:child_process';
import { it } from 'vitest';

it('recovers benchmark readings and prevents repeated paid transport requests', () => {
  execFileSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'benchmarks/vloc', '-p', 'test_*.py'], { stdio: 'pipe' });
}, 30000);
