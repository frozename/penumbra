import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.request

if len(sys.argv) != 3 or sys.argv[1] != '--live' or sys.argv[2] not in ['granite-legacy', 'granite-source']:
    raise SystemExit('Use --live granite-legacy|granite-source; no service changes')
target = sys.argv[2]
os.umask(0o077)
root = Path(__file__).resolve().parent
private = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-source-input')
output = private / (target + '.json')
if output.exists() or not (private / 'labels-adjudicated.jsonl').exists():
    raise SystemExit('Fresh output and frozen independent labels required')
sampler_path = Path('scripts/system-one-judge-resources.py')
spec = importlib.util.spec_from_file_location('existing_resources', sampler_path)
resources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resources)
lock = (Path.home() / '.penumbra/locks/heavy-job.lock').open('a')
events = []
evaluation = None
plist = Path.home() / 'Library/LaunchAgents/dev.penumbra.local-judges.plist'
original = plist.read_bytes()


def record(kind, **details):
    events.append({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'kind': kind, **details})
    (root / (target + '-lifecycle.json')).write_text(json.dumps(events, indent=2) + '\n')
    print(json.dumps(events[-1]), flush=True)


def call(url, data=None):
    request = urllib.request.Request(url, data=json.dumps(data).encode() if data else None,
                                     headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=12) as response:
        return json.load(response)


def headroom():
    text = subprocess.check_output(['vm_stat'], text=True)
    page = int(re.search(r'page size of (\d+)', text)[1])
    return sum(int(re.search(re.escape(key) + r':\s+(\d+)', text)[1]) for key in ['Pages free', 'Pages inactive']) * page


def interrupt(signum, frame):
    raise InterruptedError('operator signal ' + str(signum))


signal.signal(signal.SIGINT, interrupt)
signal.signal(signal.SIGTERM, interrupt)
record('waiting_for_existing_heavy_job_lock', target=target)
fcntl.flock(lock, fcntl.LOCK_EX)
try:
    assert call('http://127.0.0.1:51257/health')['status'] == 'ok'
    assert headroom() >= 1024 ** 3
    models = call('http://127.0.0.1:18944/v1/models')['data']
    assert all(model['status']['value'] in ['unloaded', 'sleeping'] for model in models), 'Runtime active; inspect before replay'
    warmup_start = time.monotonic()
    call('http://127.0.0.1:18944/v1/chat/completions', {'model': 'granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf', 'messages': [{'role': 'user', 'content': 'Return exactly {"memories":[]}.'}], 'max_tokens': 32, 'temperature': 0, 'response_format': {'type': 'json_object'}})
    warmup_ms = (time.monotonic() - warmup_start) * 1000
    supervision = subprocess.check_output(['launchctl', 'print', f'gui/{os.getuid()}/dev.penumbra.local-judges'], text=True)
    parent = int(re.search(r'\n\s+pid = (\d+)', supervision)[1])
    children = [int(line.split()[0]) for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,args='], text=True).splitlines() if line.split()[1] == str(parent) and 'llama-server' in line]
    assert len(children) == 1
    pid = children[0]
    baseline = resources.sample(pid, 'http://127.0.0.1:51257/health')
    record('admitted_and_warmed', modelPid=pid, routerPid=parent, warmupMs=warmup_ms,
           warmupCaveat='Existing artifact/caches, not disk-cold latency. Warmup excluded from historical quality and latency.',
           samplerSha256=hashlib.sha256(sampler_path.read_bytes()).hexdigest(), sourceCommit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip())
    failures = 0
    with (private / (target + '-driver.log')).open('x') as log, (private / (target + '-resources.jsonl')).open('x') as samples:
        evaluation = subprocess.Popen(['bun', str(root / 'eval-source-extraction.ts'), '--target', target, '--out', str(output), '--live'], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + 1200
        while evaluation.poll() is None:
            start = time.monotonic()
            row = resources.sample(pid, 'http://127.0.0.1:51257/health')
            row['freePlusInactiveBytes'] = headroom()
            samples.write(json.dumps(row) + '\n'); samples.flush()
            failures = failures + 1 if row['healthStatus'] != 200 else 0
            if row['rssBytes'] is None or row['rssBytes'] > 6 * 1024 ** 3 or row['freePlusInactiveBytes'] < 1024 ** 3 or row['swapUsedBytes'] - baseline['swapUsedBytes'] > 256 * 1024 ** 2 or failures >= 2 or time.monotonic() > deadline:
                raise RuntimeError('live resource/deadline guard refused continuation')
            time.sleep(max(0, 1 - (time.monotonic() - start)))
        code = evaluation.wait()
    record('replay_finished', exitCode=code)
    if code:
        raise RuntimeError('Replay driver failed; inspect retained private log')
finally:
    if evaluation and evaluation.poll() is None:
        os.killpg(evaluation.pid, signal.SIGTERM)
        try:
            evaluation.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(evaluation.pid, signal.SIGKILL); evaluation.wait(timeout=5)
    assert plist.read_bytes() == original, 'Runtime configuration changed'
    record('finished_without_service_mutation', samePlistSha256=hashlib.sha256(original).hexdigest(), controlPlaneStatus=call('http://127.0.0.1:51257/health')['status'])
    fcntl.flock(lock, fcntl.LOCK_UN)
    lock.close()
