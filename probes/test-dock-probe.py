#!/usr/bin/env python3
"""External CLI checks; no system permission/preference changes."""
import json, subprocess, sys, time
binary = sys.argv[1]
def run(*args):
    return subprocess.run([binary, *args], capture_output=True, text=True, timeout=12)
result = run('--help')
assert result.returncode == 0 and '--scenario' in result.stdout
for args in [('--duration', '0'), ('--duration', 'nan'), ('--interval', 'inf'), ('--scenario', 'invented')]:
    result = run(*args)
    assert result.returncode == 64 and not result.stdout, (args, result.stderr)
start = time.monotonic()
result = run('--scenario', 'hidden', '--duration', '0.3', '--interval', '0.1', '--no-overlay')
assert result.returncode == 0, result.stderr
records = [json.loads(line) for line in result.stdout.splitlines()]
assert records[0]['type'] == 'environment'
samples = [r for r in records if r['type'] == 'sample']
assert 1 <= len(samples) <= 4
assert all(s['scenario'] == 'hidden' for s in samples)
assert all(s['supportEdge'] is None for s in samples), 'Unreviewed geometry must fail closed'
assert records[-1]['type'] == 'summary' and records[-1]['productFeasibility'] == 'unverified'
assert time.monotonic() - start < 8
print('PASS: help, invalid bounds, bounded live sampling, labels, fail-closed evidence')
