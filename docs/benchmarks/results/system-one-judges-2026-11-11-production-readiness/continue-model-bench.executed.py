"""Explicit one-run local benchmark. Pauses/restores only authorized Granite."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
PRIVATE = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261111')
LOGS = PRIVATE / 'production-readiness'
PACKET = PRIVATE / 'review-200'
EVENTS = []
SAMPLERS = []
ACTIVE = None
ORIGINAL = Path('/tmp/penumbra-systemone-granite-original-command.txt').read_text().strip()
ORIGINAL_ARGS = shlex.split(ORIGINAL)


def record(kind, **fields):
    row = dict(ts=time.time(), kind=kind, **fields)
    EVENTS.append(row)
    (ROOT / 'continuation-lifecycle.json').write_text(json.dumps(EVENTS, indent=2) + '\n')
    print(json.dumps(row), flush=True)


def available(port):
    with socket.socket() as sock:
        sock.settimeout(.2)
        return sock.connect_ex(('127.0.0.1', port)) == 0


def ready(port):
    end = time.monotonic() + 45
    while time.monotonic() < end:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=.5) as response:
                if response.status == 200:
                    return
        except Exception:
            pass
        time.sleep(.1)
    raise RuntimeError(f'readiness timeout: {port}')


def identity(pid, command):
    actual = subprocess.check_output(['ps', '-p', str(pid), '-o', 'args='], text=True).strip()
    assert shlex.split(actual) == command, 'refusing to signal changed process identity'


def stop(pid, command, port, crash=False):
    identity(pid, command)
    os.kill(pid, signal.SIGKILL if crash else signal.SIGTERM)
    for _ in range(100):
        if not available(port):
            return
        time.sleep(.1)
    raise RuntimeError('server did not stop')


def launch(command, name):
    global ACTIVE
    start = time.time()
    with (LOGS / (name + '-server.log')).open('x') as log:
        child = subprocess.Popen(['nice', '-n', '10', *command], stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True)
    ACTIVE = (child.pid, command, 18944)
    ready(18944)
    data = dict(pid=child.pid, command=command, startedAtEpoch=start,
                readyAtEpoch=time.time(), startupMs=(time.time() - start) * 1000,
                cacheState='Existing artifact, OS/Metal caches; not a cold-machine measurement')
    (ROOT / (name + '-process.json')).write_text(json.dumps(data, indent=2) + '\n')
    sample = subprocess.Popen(['python3', str(REPO / 'scripts/system-one-judge-resources.py'),
        '--pid', str(child.pid), '--seconds', '900', '--out', str(ROOT / (name + '-resources.jsonl'))],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    SAMPLERS.append(sample)
    record('native_started', name=name, pid=child.pid, startupMs=data['startupMs'])
    return child.pid


def bench(name, config, fixture, concurrency=1):
    subprocess.run(['bun', 'scripts/system-one-judge-bench.ts', '--config', str(config),
        '--fixtures', str(fixture), '--out', str(ROOT / name), '--live',
        '--concurrency', str(concurrency), '--repeats', '1'], cwd=REPO, check=True, timeout=900)


def restore():
    if not available(8086):
        start = time.time()
        with (LOGS / 'granite-final-restoration.log').open('x') as log:
            child = subprocess.Popen(ORIGINAL_ARGS, stdout=log, stderr=subprocess.STDOUT,
                                     start_new_session=True)
        ready(8086)
        identity(child.pid, ORIGINAL_ARGS)
        record('granite_restored_verified', pid=child.pid, sameOriginalCommand=True,
               startupMs=(time.time() - start) * 1000)
    else:
        record('granite_listener_preserved')


def main():
    global ACTIVE
    assert sys.argv[1:] == ['--live'], 'requires explicit --live'
    assert not (ROOT / 'continuation-lifecycle.json').exists(), 'one-run output already exists'
    assert (ROOT / 't2-granite/run.json').exists(), 'finish unchanged Granite baseline first'
    assert hashlib.sha256(ORIGINAL.encode()).hexdigest() == 'c7f1d9b28097336a92251d090062b22c6178edee8cee927593b0d9dc0c7ce13a'
    assert not available(18944), 'candidate port occupied'
    paused = json.loads((ROOT / 'granite-restored.json').read_text())['pid']
    identity(paused, ORIGINAL_ARGS)
    template = json.loads((ROOT / 'nano-process.json').read_text())['command']
    config = json.loads((ROOT / 'nano-config.json').read_text())
    d1config = dict(config, model='d1-3b-eval', quantization='Q4_K_M, no mmproj',
        revision='LiquidAI/d1-3B-GGUF@bb1e436ea78eb96a3f1acb6da865f70c2fbeb563/d1-3B-Q4_K_M.gguf')
    d1path = ROOT / 'd1q4-config.json'
    d1path.write_text(json.dumps(d1config, indent=2) + '\n')
    d1command = list(template)
    d1command[d1command.index('-m') + 1] = str(PRIVATE / 'models/d1-3B-Q4_K_M.gguf')
    d1command[d1command.index('--alias') + 1] = 'd1-3b-eval'
    try:
        stop(paused, ORIGINAL_ARGS, 8086)
        record('granite_paused_authorized', pid=paused)
        launch(d1command, 'd1q4-new')
        bench('d1q4-reviewed', d1path, PACKET / 'ai-reviewed-judges-v2.jsonl')
        bench('t2-d1q4', d1path, PACKET / 't2-confirmatory-fixtures.jsonl')
        stop(*ACTIVE)
        ACTIVE = None
        launch(template, 'nano-t2')
        bench('t2-nano', ROOT / 'nano-config.json', PACKET / 't2-confirmatory-fixtures.jsonl')
        bench('t2-nano-c2', ROOT / 'nano-config.json', PACKET / 't2-confirmatory-fixtures.jsonl', 2)
        first = (PACKET / 't2-confirmatory-fixtures.jsonl').read_text().splitlines()[0] + '\n'
        recovery = PACKET / 't2-recovery-input.jsonl'
        with recovery.open('x') as output:
            recovery.chmod(0o600)
            output.write(first)
        bench('nano-recovery-before', ROOT / 'nano-config.json', recovery)
        stop(*ACTIVE, crash=True)
        ACTIVE = None
        record('native_crash_injected', signal='SIGKILL', process='dedicated experiment only')
        bench('nano-recovery-down', ROOT / 'nano-config.json', recovery)
        launch(template, 'nano-recovered')
        bench('nano-recovery-after', ROOT / 'nano-config.json', recovery)
        result = json.loads((ROOT / 'nano-recovery-after/summary.json').read_text())
        assert result['answered'] == 1 and not result['failures'], 'inference not recovered'
        record('post_restart_inference_verified', answered=1)
    finally:
        try:
            if ACTIVE and available(18944):
                stop(*ACTIVE)
                ACTIVE = None
        finally:
            restore()
            for sample in SAMPLERS:
                sample.terminate()
                try:
                    sample.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    sample.kill()
                    sample.wait(timeout=1)
            record('finished', graniteRestorationBeforeSamplerCleanup=True)


if __name__ == '__main__':
    main()
