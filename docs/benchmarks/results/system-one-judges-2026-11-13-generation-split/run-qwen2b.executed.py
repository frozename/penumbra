import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.request

if sys.argv[1:] != ['--live']:
    raise SystemExit('Explicit --live required')
root = Path(__file__).resolve().parent
private = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-generation')
metadata = json.loads((private / 'qwen2b-download-manifest.json').read_text())
model = Path(metadata['localPath'])
assert hashlib.file_digest(model.open('rb'), 'sha256').hexdigest() == metadata['actualSha256']
binary = Path('/Users/aimastermind/.local/share/penumbra/inference/system-one-llama/2cbe0ec-http-only/bin/llama-server')
plist = Path.home() / 'Library/LaunchAgents/dev.penumbra.local-judges.plist'
original = plist.read_bytes()
label = f'gui/{os.getuid()}/dev.penumbra.local-judges'
events = []
paused = False
server = evaluation = sampler = None
lock = (Path.home() / '.penumbra/locks/heavy-job.lock').open('a')

def record(kind, **details):
    events.append({'ts': time.time(), 'kind': kind, **details})
    (root / 'qwen2b-lifecycle.json').write_text(json.dumps(events, indent=2) + '\n')
    print(json.dumps(events[-1]), flush=True)

def call(url):
    with urllib.request.urlopen(url, timeout=3) as response:
        return json.load(response)

def available():
    text = subprocess.check_output(['vm_stat'], text=True)
    size = int(re.search(r'page size of (\d+)', text)[1])
    return sum(int(re.search(re.escape(k) + r':\s+(\d+)', text)[1]) for k in ['Pages free', 'Pages inactive']) * size

def swap_used():
    text = subprocess.check_output(['sysctl', 'vm.swapusage'], text=True)
    return float(re.search(r'used = ([\d.]+)M', text)[1]) * 1024**2

def stop(process):
    if process and process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)

def interrupt(signum, frame):
    raise InterruptedError('operator signal ' + str(signum))

signal.signal(signal.SIGINT, interrupt)
signal.signal(signal.SIGTERM, interrupt)
record('waiting_for_heavy_job_lock')
fcntl.flock(lock, fcntl.LOCK_EX)
try:
    assert available() >= model.stat().st_size + 1.5 * 1024**3, 'mini admission refused'
    assert call('http://127.0.0.1:51257/health')['status'] == 'ok'
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 18945))
    deadline = time.monotonic() + 120
    while True:
        models = call('http://127.0.0.1:18944/v1/models')['data']
        if all(m['status']['value'] in ['unloaded', 'sleeping'] for m in models):
            break
        if time.monotonic() > deadline:
            raise RuntimeError('mini runtime not idle')
        time.sleep(1)
    status = subprocess.check_output(['launchctl', 'print', label], text=True)
    pid = int(re.search(r'\n\s+pid = (\d+)', status)[1])
    assert str(binary) in subprocess.check_output(['ps', '-p', str(pid), '-o', 'args='], text=True)
    subprocess.run(['launchctl', 'bootout', label], check=True, capture_output=True)
    paused = True
    swap_start = swap_used()
    command = ['nice', '-n', '10', str(binary), '--model', str(model), '--alias', 'qwen35-2b-eval', '--host', '127.0.0.1', '--port', '18945', '--ctx-size', '8192', '--batch-size', '512', '--ubatch-size', '256', '--parallel', '1', '--threads', '2', '--threads-batch', '2', '--n-gpu-layers', '99', '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--cache-ram', '0', '--no-cache-idle-slots', '--no-mmproj-auto', '--offline', '--no-webui', '--jinja', '--fit', 'off']
    record('authorized_mini_runtime_paused', availableBytes=available(), command=command, artifactSha256=metadata['actualSha256'], runtimeSha256=hashlib.file_digest(binary.open('rb'), 'sha256').hexdigest())
    with (private / 'qwen2b-server.log').open('x') as logs:
        started = time.monotonic()
        server = subprocess.Popen(command, stdout=logs, stderr=subprocess.STDOUT, start_new_session=True)
        sampler = subprocess.Popen(['python3', 'scripts/system-one-judge-resources.py', '--pid', str(server.pid), '--out', str(private / 'qwen2b-resources.jsonl'), '--seconds', '420'], start_new_session=True)
        deadline = time.monotonic() + 60
        while True:
            if server.poll() is not None:
                raise RuntimeError('candidate runtime exited during startup')
            try:
                assert call('http://127.0.0.1:18945/health')['status'] == 'ok'
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise RuntimeError('candidate startup timeout')
                time.sleep(.25)
        record('candidate_ready', pid=server.pid, startupMs=(time.monotonic() - started) * 1000, metadata=call('http://127.0.0.1:18945/v1/models'))
        evaluation = subprocess.Popen(['bun', str(root / 'configured-generation-eval.ts'), '--target', 'qwen2b', '--out', str(private / 'qwen2b-configured-final.json'), '--live'], start_new_session=True)
        deadline = time.monotonic() + 360
        while evaluation.poll() is None:
            if time.monotonic() > deadline:
                raise RuntimeError('candidate evaluation TTL exceeded')
            rss = int(subprocess.check_output(['ps', '-p', str(server.pid), '-o', 'rss='], text=True).strip()) * 1024
            if available() < 1024**3 or swap_used() - swap_start > 256 * 1024**2 or rss > 4 * 1024**3:
                raise RuntimeError('candidate live resource guard refused continuation')
            time.sleep(1)
        record('evaluation_finished', exitCode=evaluation.returncode, swapGrowthBytes=swap_used() - swap_start)
        if evaluation.returncode:
            raise RuntimeError('candidate evaluation failed')
finally:
    stop(evaluation)
    stop(sampler)
    stop(server)
    if paused:
        assert plist.read_bytes() == original, 'mini preset drifted; inspect before restoring'
        result = subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], capture_output=True)
        if result.returncode and subprocess.run(['launchctl', 'print', label], capture_output=True).returncode:
            raise RuntimeError('mini supervision restore failed')
        deadline = time.monotonic() + 60
        while True:
            try:
                assert call('http://127.0.0.1:18944/health')['status'] == 'ok'
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise RuntimeError('mini runtime restore timeout')
                time.sleep(.25)
        record('mini_runtime_restored', samePlistSha256=hashlib.sha256(original).hexdigest(), health=call('http://127.0.0.1:51257/health')['status'])
    fcntl.flock(lock, fcntl.LOCK_UN)
    lock.close()
