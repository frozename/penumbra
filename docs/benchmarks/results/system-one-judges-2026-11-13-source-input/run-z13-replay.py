import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time
import urllib.request

if sys.argv[1:] != ['--live']:
    raise SystemExit('Explicit --live required; uses existing Gufo without service changes')
os.umask(0o077)
root = Path(__file__).resolve().parent
private = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-source-input')
output = private / 'z13-source.json'
if output.exists() or not (private / 'labels-adjudicated.jsonl').exists():
    raise SystemExit('Fresh output and frozen independent labels required')
previous = root.parent / 'system-one-judges-2026-11-12-z13-npu-test'
spec = importlib.util.spec_from_file_location('existing_trial_guard', previous / 'trial_guard.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
sensor_prefix = (previous / 'guarded_runtime.py').read_text().split('\ndef main():', 1)[0].replace('from trial_guard import assess_sample, assert_port_available', '')
sensor_suffix = '''
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
baseline = host_memory()
failures = 0
end = time.monotonic() + 1200
while time.monotonic() < end:
    start = time.monotonic()
    row = sample(baseline, 791917, failures, os.getpid())
    failures = row['gufoHealthFailures']
    with urllib.request.urlopen('http://127.0.0.1:8080/slots', timeout=1) as response:
        slots = json.load(response)
    row['processingSlots'] = sum(bool(slot.get('is_processing')) for slot in slots)
    row['cpuClockTicksPerSecond'] = os.sysconf('SC_CLK_TCK')
    print(json.dumps(row), flush=True)
    time.sleep(max(0, 1 - (time.monotonic() - start)))
'''
sensor_source = sensor_prefix + sensor_suffix
lock = (Path.home() / '.penumbra/locks/heavy-job.lock').open('a')
events = []
evaluation = sensor = None


def record(kind, **details):
    events.append({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'kind': kind, **details})
    (root / 'z13-source-lifecycle.json').write_text(json.dumps(events, indent=2) + '\n')
    print(json.dumps(events[-1]), flush=True)


def stop(process):
    if process and process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=5)


def interrupt(signum, frame):
    raise InterruptedError('operator signal ' + str(signum))


signal.signal(signal.SIGINT, interrupt)
signal.signal(signal.SIGTERM, interrupt)
record('waiting_for_existing_heavy_job_lock')
fcntl.flock(lock, fcntl.LOCK_EX)
try:
    with (private / 'z13-sensor-stderr.log').open('x') as stderr, (private / 'z13-source-resources.jsonl').open('x') as samples:
        sensor = subprocess.Popen(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'z13', 'python3 -u -'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, start_new_session=True)
        sensor.stdin.write(sensor_source.encode()); sensor.stdin.close()
        selector = selectors.DefaultSelector(); selector.register(sensor.stdout, selectors.EVENT_READ)

        def next_sample():
            if not selector.select(timeout=4):
                raise RuntimeError('remote sensor stalled')
            line = sensor.stdout.readline()
            if not line:
                raise RuntimeError('remote sensor exited')
            row = json.loads(line)
            samples.write(json.dumps(row) + '\n'); samples.flush()
            reason = guard.assess_sample(row, time.time(), 791917)
            if reason or row['availableBytes'] < 20 * 1024 ** 3 or row['processingSlots'] > 1:
                raise RuntimeError('resource/contention guard: ' + str(reason or 'admission floor or shared slot'))
            return row

        first = next_sample()
        if first['processingSlots'] != 0:
            raise RuntimeError('Gufo busy; defer comparison')
        record('admitted', gufoPid=791917, availableBytes=first['availableBytes'], processingSlots=0,
               existingSensorSha256=hashlib.sha256((previous / 'guarded_runtime.py').read_bytes()).hexdigest(),
               composedSensorSha256=hashlib.sha256(sensor_source.encode()).hexdigest(),
               guardSha256=hashlib.sha256((previous / 'trial_guard.py').read_bytes()).hexdigest(),
               caveat='Reuse existing Linux telemetry and guard functions, with the normal20GiB floor and stop on observed shared processing. Polling is not global coding-priority reservation.')
        with (private / 'z13-source-driver.log').open('x') as log:
            evaluation = subprocess.Popen(['bun', str(root / 'eval-source-extraction.ts'), '--target', 'z13-source', '--out', str(output), '--live'], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + 1200
            while evaluation.poll() is None:
                next_sample()
                if time.monotonic() > deadline:
                    raise RuntimeError('replay deadline')
            code = evaluation.wait()
        record('replay_finished', exitCode=code)
        if code:
            raise RuntimeError('Replay failed; retain partial results and inspect private driver log')
finally:
    stop(evaluation)
    stop(sensor)
    record('finished_without_service_mutation', note='Stopped only owned evaluation and SSH sensor processes. Gufo was neither stopped nor reconfigured.')
    fcntl.flock(lock, fcntl.LOCK_UN)
    lock.close()
