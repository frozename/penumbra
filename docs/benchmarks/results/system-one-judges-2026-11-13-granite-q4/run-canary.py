import argparse
import datetime
import fcntl
import hashlib
import importlib.util
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

parser = argparse.ArgumentParser()
parser.add_argument('--live', action='store_true')
parser.add_argument('--target', choices=['granite','graniteq4'], required=True)
parser.add_argument('--run', required=True)
args = parser.parse_args()
if not args.live or not re.fullmatch(r'[a-z0-9-]{1,48}', args.run):
    parser.error('Explicit --live and unique simple run label required')
os.umask(0o077)
sys.dont_write_bytecode = True
root = Path(__file__).resolve().parent
private = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-granite-q4')
out = private / (args.run+'.json')
if out.exists() or (root/(args.run+'-lifecycle.json')).exists():
    raise SystemExit('Fresh run label required; prior evidence is immutable')

model = Path('/Users/aimastermind/.local/share/penumbra/inference/models/granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf' if args.target=='granite' else '/Users/aimastermind/.local/share/penumbra/inference/models/granite-q4-eval/granite-4.1-3b-Q4_K_M.gguf')
binary = Path('/Users/aimastermind/.local/share/penumbra/inference/system-one-llama/2cbe0ec-http-only/bin/llama-server')
artifact_sha = hashlib.file_digest(model.open('rb'),'sha256').hexdigest()
assert artifact_sha == ('82adafd4fbac04468c905e6d259a1bf051819804ed2c055c2831f1ef786af5a9' if args.target=='granite' else '662b0626cd58f443baea23559b469df6576a81d349649c59413b36a9fb32eb29')
runtime_sha = hashlib.file_digest(binary.open('rb'),'sha256').hexdigest()
assert runtime_sha == 'a9990314838bafcbaa2601c41a375eb764489084ff2469b0770a7d47a33da104'
spec = importlib.util.spec_from_file_location('existing_resources',Path('scripts/system-one-judge-resources.py'))
resources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resources)
plist = Path.home()/'Library/LaunchAgents/dev.penumbra.local-judges.plist'
original = plist.read_bytes()
label = f'gui/{os.getuid()}/dev.penumbra.local-judges'
lock = (Path.home()/'.penumbra/locks/heavy-job.lock').open('a')
events = []
paused = False
server = evaluation = None


def record(kind, **data):
    events.append({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':kind,**data})
    (root/(args.run+'-lifecycle.json')).write_text(json.dumps(events,indent=2)+'\n')
    print(json.dumps(events[-1]),flush=True)


def call(url):
    with urllib.request.urlopen(url,timeout=3) as response:
        return json.load(response)


def headroom():
    vm = subprocess.check_output(['vm_stat'],text=True)
    page = int(re.search(r'page size of (\d+)',vm)[1])
    return sum(int(re.search(re.escape(k)+r':\s+(\d+)',vm)[1]) for k in ['Pages free','Pages inactive'])*page


def stop(process):
    if process and process.poll() is None:
        os.killpg(process.pid,signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGKILL)
            process.wait(timeout=5)


def interrupt(signum, frame):
    raise InterruptedError('operator signal '+str(signum))


signal.signal(signal.SIGINT,interrupt)
signal.signal(signal.SIGTERM,interrupt)
record('waiting_for_existing_heavy_job_lock',target=args.target)
fcntl.flock(lock,fcntl.LOCK_EX)
try:
    assert headroom() >= model.stat().st_size+1.5*1024**3, 'mini admission refused'
    assert call('http://127.0.0.1:51257/health')['status'] == 'ok'
    with socket.socket() as probe:
        probe.bind(('127.0.0.1',18945))
    deadline = time.monotonic()+120
    while not all(m['status']['value'] in ['unloaded','sleeping'] for m in call('http://127.0.0.1:18944/v1/models')['data']):
        if time.monotonic() > deadline:
            raise RuntimeError('mini runtime not idle')
        time.sleep(1)
    status = subprocess.check_output(['launchctl','print',label],text=True)
    router = int(re.search(r'\n\s+pid = (\d+)',status)[1])
    assert str(binary) in subprocess.check_output(['ps','-p',str(router),'-o','args='],text=True)
    baseline = resources.sample(router,'http://127.0.0.1:51257/health')
    subprocess.run(['launchctl','bootout',label],check=True,capture_output=True)
    paused = True
    command = ['nice','-n','10',str(binary),'--model',str(model),'--alias','granite-q8-canary' if args.target=='granite' else 'granite-q4-canary','--host','127.0.0.1','--port','18945','--ctx-size','16384','--batch-size','512','--ubatch-size','256','--parallel','1','--threads','2','--threads-batch','2','--n-gpu-layers','99','--flash-attn','on','--cache-type-k','q8_0','--cache-type-v','q8_0','--cache-ram','0','--no-cache-idle-slots','--no-mmproj-auto','--offline','--no-webui','--jinja','--fit','off']
    record('authorized_mini_runtime_paused',routerPid=router,command=command,artifactSha256=artifact_sha,runtimeSha256=runtime_sha)
    with (private/(args.run+'-server.log')).open('x') as log, (private/(args.run+'-resources.jsonl')).open('x') as samples:
        start = time.monotonic()
        server = subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        failures = 0

        def next_sample():
            global failures
            if server.poll() is not None:
                raise RuntimeError('owned candidate runtime exited')
            row = resources.sample(server.pid,'http://127.0.0.1:51257/health')
            row['freePlusInactiveBytes'] = headroom()
            samples.write(json.dumps(row)+'\n');samples.flush()
            failures = failures+1 if row.get('healthStatus') != 200 else 0
            if row['rssBytes'] is None or row['rssBytes'] > 6*1024**3 or row['freePlusInactiveBytes'] < 1024**3 or row['swapUsedBytes']-baseline['swapUsedBytes'] > 256*1024**2 or failures >= 2:
                raise RuntimeError('mini startup/inference guard refused continuation')
            return row

        deadline = time.monotonic()+60
        while True:
            next_sample()
            try:
                assert call('http://127.0.0.1:18945/health')['status'] == 'ok'
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise RuntimeError('candidate cold-start timeout')
                time.sleep(.25)
        record('candidate_ready',pid=server.pid,startupMs=(time.monotonic()-start)*1000,metadata=call('http://127.0.0.1:18945/v1/models'))
        with (private/(args.run+'-driver.log')).open('x') as driver_log:
            evaluation = subprocess.Popen(['bun',str(root/'contract-canary.ts'),'--live','--target',args.target,'--out',str(out)],stdout=driver_log,stderr=subprocess.STDOUT,start_new_session=True)
            deadline = time.monotonic()+1200
            while evaluation.poll() is None:
                at = time.monotonic();next_sample()
                if time.monotonic() > deadline:
                    raise RuntimeError('evaluation deadline exceeded')
                time.sleep(max(0,1-(time.monotonic()-at)))
            code = evaluation.wait()
        record('replay_finished',exitCode=code)
        if code:
            raise RuntimeError('Driver failed; inspect private log')
except BaseException as error:
    record('aborted',reason=str(error))
    raise
finally:
    stop(evaluation);stop(server)
    if paused:
        assert plist.read_bytes() == original, 'restore refused: preset changed'
        restored = subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(plist)],capture_output=True)
        if restored.returncode and subprocess.run(['launchctl','print',label],capture_output=True).returncode:
            raise RuntimeError('mini supervision restore failed')
        deadline = time.monotonic()+60
        while True:
            try:
                assert call('http://127.0.0.1:18944/health')['status'] == 'ok'
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise RuntimeError('mini runtime restore timeout')
                time.sleep(.25)
        record('mini_runtime_restored',samePlistSha256=hashlib.sha256(original).hexdigest(),daemonHealth=call('http://127.0.0.1:51257/health')['status'])
    fcntl.flock(lock,fcntl.LOCK_UN);lock.close()
