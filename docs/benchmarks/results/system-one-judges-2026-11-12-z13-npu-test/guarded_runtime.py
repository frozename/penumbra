"""Linux task-only NPU supervisor; never stops or reconfigures Gufo."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import time
import urllib.request

from trial_guard import assess_sample


def read(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def host_memory():
    values = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        k, v = line.split(':', 1)
        if k in ['MemAvailable', 'SwapTotal', 'SwapFree']:
            values[k] = int(v.split()[0]) * 1024
    values['swapUsed'] = values['SwapTotal'] - values['SwapFree']
    vm = dict(line.split() for line in Path('/proc/vmstat').read_text().splitlines())
    values['swapout'] = int(vm['pswpout']) * os.sysconf('SC_PAGE_SIZE')
    return values


def gufo_pid():
    result = subprocess.run(['ss', '-ltnp', 'sport = :8080'], capture_output=True, text=True, timeout=1)
    match = re.search(r'"gufo[^"\n]*",pid=(\d+)', result.stdout)
    return int(match[1]) if match else None


def health():
    start = time.monotonic()
    try:
        with urllib.request.urlopen('http://127.0.0.1:8080/v1/models', timeout=0.5) as r:
            r.read(131072)
            ok = r.status == 200
    except Exception:
        ok = False
    return ok, (time.monotonic() - start) * 1000


def process_stats(pid):
    result = {'rssBytes': None, 'cpuTicks': None}
    text = read(f'/proc/{pid}/stat')
    if text:
        parts = text[text.rindex(')') + 2:].split()
        result['cpuTicks'] = int(parts[11]) + int(parts[12])
        result['rssBytes'] = int(parts[21]) * os.sysconf('SC_PAGE_SIZE')
    return result


def sample(baseline, expected_pid, failures, runtime_pid):
    measured = time.time()
    memory = host_memory()
    ok, latency = health()
    failures = 0 if ok else failures + 1
    pressure = read('/proc/pressure/memory') or ''
    full = re.search(r'^full avg10=([\d.]+)', pressure, re.M)
    temperatures = []
    for path in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
        value = read(path)
        if value and value.lstrip('-').isdigit():
            temperatures.append(int(value) / 1000)
    gpu = {}
    for path in Path('/sys/class/drm').glob('card*/device/gpu_busy_percent'):
        gpu[str(path)] = read(path)
    cgroup = Path('/sys/fs/cgroup') / Path('/proc/self/cgroup').read_text().strip().split('::', 1)[1].lstrip('/')
    return dict(
        measuredAt=measured, availableBytes=memory['MemAvailable'],
        swapGrowthBytes=max(0, memory['swapUsed'] - baseline['swapUsed']),
        swapoutBytes=max(0, memory['swapout'] - baseline['swapout']),
        memoryFullAvg10=float(full[1]) if full else None,
        maxTemperatureC=max(temperatures) if temperatures else None,
        gufoHealthFailures=failures, gufoHealthMs=latency, gufoPid=gufo_pid(),
        runtime=process_stats(runtime_pid), gufo=process_stats(expected_pid),
        cgroup={key: read(cgroup / key) for key in ['memory.current', 'memory.peak', 'memory.events', 'memory.max', 'memory.high', 'memory.swap.max', 'cpu.stat', 'cpu.max']},
        gpuBusyPercent=gpu,
        npuPowerState=read('/sys/class/accel/accel0/device/power/runtime_status'),
        npuUtilizationPercent=None,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--model', choices=['lite', 'nano'], required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    lock_path = Path.home() / '.penumbra/locks/heavy-job.lock'
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock = lock_path.open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    gufo = gufo_pid()
    if gufo is None or not health()[0]:
        raise RuntimeError('Gufo baseline identity/health unavailable')
    baseline = host_memory()
    env = dict(os.environ, FLM_MODEL_PATH=str(root),
               FLM_CONFIG_PATH=str(root / 'runtime/model_list.json'),
               FLM_MODELINFO_PATH=str(root / 'runtime/model_info.json'),
               FLM_XCLBIN_PATH=str(root / 'runtime/xclbins'),
               OMP_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2')
    command = [str(root / 'runtime/flm'), 'serve', '--decision', 'd3:' + args.model,
               '--host', '127.0.0.1', '--port', '52625', '--pmode', 'default']
    result = dict(status='starting', model=args.model, admissionFloorIgnored=True,
                  authority='none', startedAt=time.time(), command=command, gufoPid=gufo,
                  npuUtilization='not available from inspected unprivileged counters')
    child = None
    started = time.monotonic()
    reason = None
    try:
        with socket.socket() as port_probe:
            port_probe.bind(('127.0.0.1', 52625))
        first = sample(baseline, gufo, 0, os.getpid())
        reason = assess_sample(first, time.time(), gufo)
        if reason:
            raise RuntimeError(reason)
        with (args.out / 'runtime.log').open('w') as log, (args.out / 'resources.jsonl').open('w') as samples:
            child = subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
            result['runtimePid'] = child.pid
            failures = 0
            while not stopping:
                tick = time.monotonic()
                row = sample(baseline, gufo, failures, child.pid)
                failures = row['gufoHealthFailures']
                row['elapsedSeconds'] = tick - started
                samples.write(json.dumps(row) + '\n')
                samples.flush()
                reason = assess_sample(row, time.time(), gufo)
                if reason or child.poll() is not None or tick - started > 570:
                    reason = reason or ('runtime_exit' if child.poll() is not None else 'runtime_deadline')
                    break
                time.sleep(max(0, 1 - (time.monotonic() - tick)))
    except Exception as error:
        reason = reason or type(error).__name__ + ': ' + str(error)
    finally:
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        result.update(status='aborted' if reason else 'stopped', reason=reason,
                      elapsedSeconds=time.monotonic() - started, endedAt=time.time(),
                      gufoPidAfter=gufo_pid(), runtimeExitCode=child.returncode if child else None)
        (args.out / 'guard.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
