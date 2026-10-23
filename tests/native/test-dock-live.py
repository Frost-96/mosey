#!/usr/bin/env python3
"""Bounded real-process CLI seam. Never grants permission or saves pixels."""
import json, os, pathlib, subprocess, sys, tempfile, time
binary=sys.argv[1]
def run(*args):
    return subprocess.run([binary,*args],capture_output=True,text=True,timeout=20)
assert run('--help').returncode==0
for args in [('--duration','nan'),('--duration','0'),('--interval','0'),('--threshold','256'),('--orientation','unknown'),('--output','relative.jsonl'),('--callback-timeout','0')]:
    result=run(*args)
    assert result.returncode==64 and not result.stdout,(args,result.stdout,result.stderr)
start=time.monotonic()
result=run('--duration','0.2','--interval','0.1','--idle-current','--callback-timeout','0.5')
assert result.returncode in [0,2],result.stderr
records=[json.loads(line) for line in result.stdout.splitlines()]
assert records[0]['type']=='environment' and records[0]['buildMode']=='optimized_-O'
assert records[0]['idleCurrentPolicy'] is True and records[0]['callbackTimeoutSeconds']==0.5
assert records[-1]['type']=='summary' and records[-1]['supportEdge'] is None
assert all(r.get('supportEdge') is None for r in records)
if any(r.get('status')=='permission_unavailable' for r in records):
    assert result.returncode==2
    assert not any(r['type']=='stream_configuration' for r in records)
assert time.monotonic()-start<15
with tempfile.TemporaryDirectory(prefix='mosey-live-cli-') as directory:
    existing=pathlib.Path(directory)/'existing.jsonl'
    existing.write_text('preserve me')
    result=run('--duration','0.1','--output',str(existing))
    assert result.returncode==73 and existing.read_text()=='preserve me'
print('PASS: CLI validation, bounded native lifecycle, fail-closed/no-permission-request output')

# A real full stdout pipe can block the first environment record, even without TCC.
readfd,writefd=os.pipe()
os.set_blocking(writefd,False)
try:
    while True: os.write(writefd,b'x'*4096)
except BlockingIOError: pass
os.set_blocking(writefd,True)
started=time.monotonic()
blocked=subprocess.Popen([binary,'--duration','0.1'],stdout=writefd,stderr=subprocess.DEVNULL)
os.close(writefd)
try:
    try: code=blocked.wait(timeout=13)
    except subprocess.TimeoutExpired:
        blocked.kill();blocked.wait();raise AssertionError('Full stdout pipe prevented the hard deadline')
    assert code==124,code
    assert time.monotonic()-started<13
finally: os.close(readfd)
print('PASS: prefilled stdout cannot prevent duration+10s hard termination')
