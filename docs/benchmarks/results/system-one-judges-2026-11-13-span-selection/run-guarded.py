import argparse
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time
import urllib.request
from clock_calibration import estimate_offset

parser = argparse.ArgumentParser()
parser.add_argument('--live', action='store_true')
parser.add_argument('--target', choices=['granite', 'z13'], required=True)
parser.add_argument('--split', choices=['dev', 'test'], required=True)
parser.add_argument('--run', required=True)
args = parser.parse_args()
if not args.live or not re.fullmatch(r'[a-z0-9-]{1,48}', args.run):
    parser.error('Explicit --live and a simple unique run label required')
os.umask(0o077)
sys.dont_write_bytecode = True
root = Path(__file__).resolve().parent
private = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-span-selection')
out = private / (args.run + '.json')
if out.exists() or (root / (args.run + '-lifecycle.json')).exists():
    raise SystemExit('Fresh run label required; prior measurements are immutable')
if args.split == 'test' and not (private / 'labels-adjudicated.jsonl').exists():
    raise SystemExit('Frozen independent labels required')


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


resources = module('existing_macos_resources', Path('scripts/system-one-judge-resources.py'))
previous = root.parent / 'system-one-judges-2026-11-12-z13-npu-test'
guard = module('existing_trial_guard', previous / 'trial_guard.py')
lock = (Path.home() / '.penumbra/locks/heavy-job.lock').open('a')
events = []
evaluation = sensor = None
plist = Path.home() / 'Library/LaunchAgents/dev.penumbra.local-judges.plist'
original = plist.read_bytes()


def record(kind, **data):
    events.append({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'kind': kind, **data})
    (root / (args.run + '-lifecycle.json')).write_text(json.dumps(events, indent=2) + '\n')
    print(json.dumps(events[-1]), flush=True)


def call(url, data=None):
    request = urllib.request.Request(url, data=json.dumps(data).encode() if data else None, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=12) as response:
        return json.load(response)


def headroom():
    text = subprocess.check_output(['vm_stat'], text=True)
    page = int(re.search(r'page size of (\d+)', text)[1])
    return sum(int(re.search(re.escape(k)+r':\s+(\d+)', text)[1]) for k in ['Pages free', 'Pages inactive']) * page


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
record('waiting_for_existing_heavy_job_lock', target=args.target, split=args.split)
fcntl.flock(lock, fcntl.LOCK_EX)
try:
    assert call('http://127.0.0.1:51257/health')['status'] == 'ok'
    with (private / (args.run+'-resources.jsonl')).open('x') as samples, (private / (args.run+'-sensor-stderr.log')).open('x') as stderr:
        if args.target == 'granite':
            assert headroom() >= 1024**3
            assert all(row['status']['value'] in ['unloaded','sleeping'] for row in call('http://127.0.0.1:18944/v1/models')['data'])
            call('http://127.0.0.1:18944/v1/chat/completions', {'model':'granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf','messages':[{'role':'user','content':'Return exactly {"memories":[]}.'}],'max_tokens':32,'temperature':0,'response_format':{'type':'json_object'}})
            status = subprocess.check_output(['launchctl','print',f'gui/{os.getuid()}/dev.penumbra.local-judges'],text=True)
            parent = int(re.search(r'\n\s+pid = (\d+)',status)[1])
            children = [int(line.split()[0]) for line in subprocess.check_output(['ps','-axo','pid=,ppid=,args='],text=True).splitlines() if line.split()[1]==str(parent) and 'llama-server' in line]
            assert len(children)==1
            pid = children[0]
            baseline = resources.sample(pid,'http://127.0.0.1:51257/health')
            def next_sample():
                row = resources.sample(pid,'http://127.0.0.1:51257/health')
                row['freePlusInactiveBytes'] = headroom()
                samples.write(json.dumps(row)+'\n');samples.flush()
                if row['rssBytes'] is None or row['rssBytes']>6*1024**3 or row['freePlusInactiveBytes']<1024**3 or row['swapUsedBytes']-baseline['swapUsedBytes']>256*1024**2:
                    raise RuntimeError('mini resource guard refused continuation')
                return row
            record('admitted', modelPid=pid, routerPid=parent, samplerSha256=hashlib.sha256(Path('scripts/system-one-judge-resources.py').read_bytes()).hexdigest())
        else:
            before=time.time()
            remote=float(subprocess.check_output(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5','z13','python3 -c "import time;print(time.time())"'],text=True,timeout=6))
            after=time.time()
            offset,uncertainty=estimate_offset(before,after,remote)
            record('remote_clock_calibrated',offsetSeconds=offset,uncertaintySeconds=uncertainty,roundTripSeconds=after-before)
            prefix = (previous/'guarded_runtime.py').read_text().split('\ndef main():',1)[0].replace('from trial_guard import assess_sample, assert_port_available','')
            suffix = '''
signal.signal(signal.SIGPIPE,signal.SIG_DFL)
baseline=host_memory();failures=0
for _ in range(1200):
    start=time.monotonic();row=sample(baseline,791917,failures,os.getpid());failures=row['gufoHealthFailures']
    with urllib.request.urlopen('http://127.0.0.1:8080/slots',timeout=1) as response:slots=json.load(response)
    row['processingSlots']=sum(bool(s.get('is_processing'))for s in slots)
    row['cpuClockTicksPerSecond']=os.sysconf('SC_CLK_TCK')
    print(json.dumps(row),flush=True);time.sleep(max(0,1-(time.monotonic()-start)))
'''
            sensor_source = prefix+suffix
            sensor = subprocess.Popen(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5','z13','python3 -u -'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr,start_new_session=True)
            sensor.stdin.write(sensor_source.encode());sensor.stdin.close()
            selector=selectors.DefaultSelector();selector.register(sensor.stdout,selectors.EVENT_READ)
            def next_sample():
                if not selector.select(timeout=4):raise RuntimeError('remote sensor stalled')
                line=sensor.stdout.readline()
                if not line:raise RuntimeError('remote sensor exited')
                row=json.loads(line)
                row['clientNormalizedTs']=row['measuredAt']-offset
                row['remoteClockOffsetSeconds']=offset
                samples.write(json.dumps(row)+'\n');samples.flush()
                reason=guard.assess_sample(row,time.time()+offset+uncertainty,791917)
                if reason or row['availableBytes']<20*1024**3 or row['processingSlots']>1:raise RuntimeError('Z13 resource/contention guard: '+str(reason))
                return row
            first=next_sample();assert first['processingSlots']==0
            record('admitted',gufoPid=791917,availableBytes=first['availableBytes'],processingSlots=0,composedSensorSha256=hashlib.sha256(sensor_source.encode()).hexdigest())
        with (private/(args.run+'-driver.log')).open('x') as log:
            evaluation=subprocess.Popen(['bun',str(root/'eval-span-selection.ts'),'--target',args.target,'--split',args.split,'--out',str(out),'--live'],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            failures=0;deadline=time.monotonic()+1200
            while evaluation.poll() is None:
                start=time.monotonic();row=next_sample()
                failed=row.get('healthStatus')!=200 if args.target=='granite' else row['gufoHealthFailures']>0
                failures=failures+1 if failed else 0
                if failures>=2 or time.monotonic()>deadline:raise RuntimeError('health/deadline guard refused continuation')
                if args.target=='granite':time.sleep(max(0,1-(time.monotonic()-start)))
            code=evaluation.wait()
        record('replay_finished',exitCode=code)
        if code:raise RuntimeError('Driver failed; inspect preserved private log')
except BaseException as error:
    record('aborted',reason=str(error))
    raise
finally:
    stop(evaluation);stop(sensor)
    assert plist.read_bytes()==original
    record('finished_without_service_mutation',samePlistSha256=hashlib.sha256(original).hexdigest())
    fcntl.flock(lock,fcntl.LOCK_UN);lock.close()
