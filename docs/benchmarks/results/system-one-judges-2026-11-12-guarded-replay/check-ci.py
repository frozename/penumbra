from pathlib import Path
import datetime,hashlib,json,os,re,signal,subprocess,sys,time,urllib.request
if sys.argv[1:]!=['--live']:raise SystemExit('Explicit --live required, invoked under existing heavy-job lock')
root=Path(__file__).resolve().parent;private=Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261111/resume-20261112');log_path=private/'check-ci-shadow-timeout-fix.log';assert not log_path.exists()
source=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();plist=Path.home()/'Library/LaunchAgents/dev.penumbra.local-judges.plist';original=plist.read_bytes();label='gui/501/dev.penumbra.local-judges';events=[];ci=None;paused=False

def record(kind,**details):
 events.append({'ts':time.time(),'kind':kind,**details});(root/'ci-lifecycle.json').write_text(json.dumps(events,indent=2)+'\n');print(json.dumps(events[-1]),flush=True)

def call(url):
 with urllib.request.urlopen(url,timeout=3) as response:return json.load(response)

def interrupt(signum,frame):raise InterruptedError('operator signal '+str(signum))
signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
try:
 assert call('http://127.0.0.1:51257/health')['status']=='ok'
 deadline=time.monotonic()+120
 while True:
  models=call('http://127.0.0.1:18944/models')['data']
  if all(m['status']['value'] in ['unloaded','sleeping'] for m in models):break
  if time.monotonic()>deadline:raise RuntimeError('inference not idle; refusing pause')
  time.sleep(1)
 status=subprocess.check_output(['launchctl','print',label],text=True);pid=int(re.search(r'\n\s+pid = (\d+)',status)[1]);args=subprocess.check_output(['ps','-p',str(pid),'-o','args='],text=True);assert '/Users/aimastermind/.local/share/penumbra/inference/system-one-llama/2cbe0ec-http-only/bin/llama-server --models-preset' in args
 record('lock_acquired_preflight_passed',sourceCommit=source,inferenceIdle=True,pid=pid)
 subprocess.run(['launchctl','bootout',label],check=True,capture_output=True);paused=True
 deadline=time.monotonic()+90
 while subprocess.run(['kill','-0',str(pid)],capture_output=True).returncode==0:
  if time.monotonic()>deadline:raise RuntimeError('runtime stop timeout')
  time.sleep(.25)
 record('authorized_granite_runtime_paused',pid=pid,otherInferenceServicesChanged=False)
 start=time.time()
 with log_path.open('x') as output:
  ci=subprocess.Popen(['bun','run','check:ci'],stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
  code=ci.wait()
 record('ci_finished',exitCode=code,elapsedSeconds=time.time()-start)
finally:
 if ci and ci.poll() is None:
  os.killpg(ci.pid,signal.SIGTERM)
  try:ci.wait(timeout=20)
  except subprocess.TimeoutExpired:os.killpg(ci.pid,signal.SIGKILL);ci.wait(timeout=5)
 if paused:
  assert plist.read_bytes()==original,'runtime configuration drifted; inspect before restoring'
  for _ in range(30):
   result=subprocess.run(['launchctl','bootstrap','gui/501',str(plist)],capture_output=True,text=True)
   if result.returncode==0 or subprocess.run(['launchctl','print',label],capture_output=True).returncode==0:break
   time.sleep(1)
  else:raise RuntimeError('could not restore runtime supervision')
  deadline=time.monotonic()+60
  while True:
   try:assert call('http://127.0.0.1:18944/health')['status']=='ok';break
   except Exception:
    if time.monotonic()>deadline:raise RuntimeError('runtime readiness after CI failed')
    time.sleep(.25)
  record('runtime_restored',samePlistSha256=hashlib.sha256(original).hexdigest(),controlPlaneStatus=call('http://127.0.0.1:51257/health')['status'])
if ci is None:raise SystemExit('CI not started')
code=ci.returncode
smoke=subprocess.run(['bun',str(root/'post-ci-granite-smoke.ts'),'--live'],capture_output=True,text=True,timeout=100)
record('post_restore_inference',exitCode=smoke.returncode)
data={'sourceCommit':source,'command':'bun run check:ci','ciExitCode':code,'runtimePlistUnchanged':plist.read_bytes()==original,'postRestoreInferenceExitCode':smoke.returncode,'rawLogPath':str(log_path),'rawLogSha256':hashlib.file_digest(log_path.open('rb'),'sha256').hexdigest(),'heavyJobLock':str(Path.home()/'.penumbra/locks/heavy-job.lock'),'status':'passed' if code==0 and smoke.returncode==0 else 'failed'}
(root/'ci-validation.json').write_text(json.dumps(data,indent=2)+'\n');print(json.dumps(data),flush=True)
raise SystemExit(code or smoke.returncode)
