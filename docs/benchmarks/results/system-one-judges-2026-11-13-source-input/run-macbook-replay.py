import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time

if sys.argv[1:] != ['--live']:
    raise SystemExit('Explicit --live required; uses existing Kapitsa without service changes')
os.umask(0o077)
root = Path(__file__).resolve().parent
private = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-source-input')
output = private / 'macbook-source.json'
if output.exists() or not (private / 'labels-adjudicated.jsonl').exists():
    raise SystemExit('Fresh output and frozen independent labels required')
sampler_path = Path('scripts/system-one-judge-resources.py')
sensor_prefix = sampler_path.read_text().split('\ndef main():', 1)[0]
sensor_suffix = '''
import os,signal
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
end = time.monotonic() + 1200
while time.monotonic() < end:
    start = time.monotonic()
    row = sample(39656, 'http://127.0.0.1:18200/health')
    vm = command(['vm_stat'])
    page = int(re.search(r'page size of (\\d+)', vm)[1])
    row['freePlusInactiveBytes'] = sum(int(re.search(re.escape(key) + r':\\s+(\\d+)', vm)[1]) for key in ['Pages free', 'Pages inactive']) * page
    row['pageSizeBytes'] = page
    row['memoryPressureLevel'] = int(command(['sysctl', '-n', 'kern.memorystatus_vm_pressure_level']).strip())
    connections = command(['/usr/sbin/lsof', '-nP', '-a', '-p', '39656', '-iTCP:18200', '-sTCP:ESTABLISHED', '-Ff'])
    row['establishedClientConnections'] = sum(line.startswith('f') for line in connections.splitlines())
    print(json.dumps(row), flush=True)
    time.sleep(max(0, 1 - (time.monotonic() - start)))
'''
sensor_source = sensor_prefix + sensor_suffix
lock = (Path.home() / '.penumbra/locks/heavy-job.lock').open('a')
events = []
evaluation = sensor = None


def record(kind, **details):
    events.append({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'kind': kind, **details})
    (root / 'macbook-source-lifecycle.json').write_text(json.dumps(events, indent=2) + '\n')
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
    with (private / 'macbook-sensor-stderr.log').open('x') as stderr, (private / 'macbook-source-resources.jsonl').open('x') as samples:
        sensor = subprocess.Popen(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ControlMaster=no', 'acordeiro@192.168.68.140', 'python3 -u -'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, start_new_session=True)
        sensor.stdin.write(sensor_source.encode()); sensor.stdin.close()
        selector = selectors.DefaultSelector(); selector.register(sensor.stdout, selectors.EVENT_READ)
        baseline = None
        failures = 0

        def next_sample():
            if not selector.select(timeout=8):
                raise RuntimeError('remote sensor stalled')
            line = sensor.stdout.readline()
            if not line:
                raise RuntimeError('remote sensor exited')
            row = json.loads(line)
            samples.write(json.dumps(row) + '\n'); samples.flush()
            if not -1 <= time.time() - row['ts'] <= 8 or row['rssBytes'] is None or row['memoryPressureLevel'] != 1 or row['freePlusInactiveBytes'] < int(9.6 * 1024 ** 3) or row['establishedClientConnections'] > 1:
                raise RuntimeError('memory/pressure/contention guard refused continuation')
            return row

        baseline = next_sample()
        if baseline['establishedClientConnections'] != 0 or baseline['healthStatus'] != 200:
            raise RuntimeError('Kapitsa is busy or unhealthy; defer comparison')
        record('admitted', modelPid=39656, freePlusInactiveBytes=baseline['freePlusInactiveBytes'], memoryPressureLevel=baseline['memoryPressureLevel'], establishedClientConnections=0,
               existingSamplerSha256=hashlib.sha256(sampler_path.read_bytes()).hexdigest(), composedSensorSha256=hashlib.sha256(sensor_source.encode()).hexdigest(),
               capacityCaveat='Normal pressure and free-plus-inactive memory are current snapshots. TCP polling is a contention heuristic, not shared coding-priority reservation. Existing swap is retained; growth and new swap-outs are guarded. RSS excludes some unified GPU allocations.')
        with (private / 'macbook-source-driver.log').open('x') as log:
            evaluation = subprocess.Popen(['bun', str(root / 'eval-source-extraction.ts'), '--target', 'macbook-source', '--out', str(output), '--live'], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + 1200
            while evaluation.poll() is None:
                row = next_sample()
                failures = failures + 1 if row['healthStatus'] != 200 else 0
                if failures >= 2 or row['swapUsedBytes'] - baseline['swapUsedBytes'] > 256 * 1024 ** 2 or (row['swapouts'] - baseline['swapouts']) * row['pageSizeBytes'] > 128 * 1024 ** 2 or time.monotonic() > deadline:
                    raise RuntimeError('health/swap/deadline guard refused continuation')
            code = evaluation.wait()
        record('replay_finished', exitCode=code)
        if code:
            raise RuntimeError('Replay failed; retain partial results and inspect private log')
finally:
    stop(evaluation)
    stop(sensor)
    record('finished_without_service_mutation', note='Stopped only owned evaluation and SSH sensor processes. Kapitsa was neither stopped nor reconfigured.')
    fcntl.flock(lock, fcntl.LOCK_UN)
    lock.close()
