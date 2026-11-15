import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.request

retry = sys.argv[1:] == ['--live', '--retry']
final = sys.argv[1:] == ['--live', '--final']
if sys.argv[1:] != ['--live'] and not retry and not final:
    raise SystemExit('Explicit --live required; pauses only the user-authorized mini judge runtime')
root = Path(__file__).resolve().parent
private = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-routing-repair')
suffix = '.final' if final else '.retry' if retry else ''
log_path = private / ('check-ci' + suffix + '.log')
if log_path.exists():
    raise SystemExit('Fresh CI log required')
source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
assert not subprocess.check_output(['git','status','--porcelain','--','packages','scripts','plugin'],text=True).strip(), 'Package/script code drifted; freeze source before CI'
package_tree = subprocess.check_output(['git','rev-parse','HEAD:packages'],text=True).strip()
plist = Path.home() / 'Library/LaunchAgents/dev.penumbra.local-judges.plist'
original = plist.read_bytes()
label = f'gui/{os.getuid()}/dev.penumbra.local-judges'
events = []
os.umask(0o077)
postflight_error = None
ci = None
paused = False

def record(kind, **details):
    events.append({'ts': time.time(), 'kind': kind, **details})
    (root / ('package-ci-lifecycle' + suffix + '.json')).write_text(json.dumps(events, indent=2) + '\n')
    print(json.dumps(events[-1]), flush=True)

def call(path):
    with urllib.request.urlopen(path, timeout=3) as response:
        return json.load(response)

def interrupt(signum, frame):
    raise InterruptedError('operator signal ' + str(signum))

signal.signal(signal.SIGINT, interrupt)
signal.signal(signal.SIGTERM, interrupt)
lock_path = Path.home() / '.penumbra/locks/heavy-job.lock'
lock = lock_path.open('a')
fcntl.flock(lock, fcntl.LOCK_EX)
try:
    assert call('http://127.0.0.1:51257/health')['status'] == 'ok'
    deadline = time.monotonic() + 120
    while True:
        models = call('http://127.0.0.1:18944/v1/models')['data']
        if all(m['status']['value'] in ['unloaded', 'sleeping'] for m in models):
            break
        if time.monotonic() > deadline:
            raise RuntimeError('runtime not idle; refusing pause')
        time.sleep(1)
    status = subprocess.check_output(['launchctl', 'print', label], text=True)
    pid = int(re.search(r'\n\s+pid = (\d+)', status)[1])
    args = subprocess.check_output(['ps', '-p', str(pid), '-o', 'args='], text=True)
    assert '/system-one-llama/2cbe0ec-http-only/bin/llama-server --models-preset' in args
    record('lock_and_idle_preflight_passed', sourceCommit=source, pid=pid)
    subprocess.run(['launchctl', 'bootout', label], check=True, capture_output=True)
    paused = True
    record('authorized_mini_runtime_paused', otherInferenceServicesChanged=False)
    with log_path.open('x') as output:
        ci = subprocess.Popen(['bun', 'run', 'check:ci'], stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        code = ci.wait()
    record('ci_finished', exitCode=code)
finally:
    if ci and ci.poll() is None:
        os.killpg(ci.pid, signal.SIGTERM)
        try:
            ci.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(ci.pid, signal.SIGKILL)
            ci.wait(timeout=5)
    if paused:
        assert plist.read_bytes() == original, 'runtime configuration changed during CI'
        result = subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], capture_output=True)
        if result.returncode and subprocess.run(['launchctl', 'print', label], capture_output=True).returncode:
            raise RuntimeError('runtime supervision restore failed')
        deadline = time.monotonic() + 60
        while True:
            try:
                assert call('http://127.0.0.1:18944/health')['status'] == 'ok'
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise RuntimeError('runtime readiness restore failed')
                time.sleep(.25)
        record('runtime_router_restored', samePlistSha256=hashlib.sha256(original).hexdigest())
        try:
            record('control_plane_postflight',status=call('http://127.0.0.1:51257/health')['status'])
        except Exception as error:
            postflight_error=str(error)
            record('control_plane_postflight_failed',reason=postflight_error)
    fcntl.flock(lock, fcntl.LOCK_UN)
    lock.close()
if ci is None:
    raise SystemExit('CI not started')
proof = {'sourceCommit': source, 'command': 'bun run check:ci', 'ciExitCode': ci.returncode,
         'rawLogSha256': hashlib.sha256(log_path.read_bytes()).hexdigest(), 'rawLogPath': str(log_path),
         'runtimePlistUnchanged': plist.read_bytes() == original, 'heavyJobLock': str(lock_path),
         'status': 'passed' if ci.returncode == 0 else 'failed', 'packageTree':package_tree,
         'postflightError':postflight_error,'scope':'Fresh full CI on committed routing/privacy/cache repair and current configurable benchmark. Experimental docs helpers have separate validation.'}
(root / ('package-ci-validation' + suffix + '.json')).write_text(json.dumps(proof, indent=2) + '\n')
print(json.dumps(proof), flush=True)
raise SystemExit(ci.returncode or (1 if postflight_error else 0))
