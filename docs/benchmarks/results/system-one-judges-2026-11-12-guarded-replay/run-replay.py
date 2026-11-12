from pathlib import Path
import sys
sys.dont_write_bytecode=True
import datetime,hashlib,importlib.util,json,os,re,signal,subprocess,threading,time,urllib.request
from guard import assess_guard,observer_status,ADMIT_BYTES,RESERVE_BYTES,SWAP_BOUND
if sys.argv[1:]!=['--live']:raise SystemExit('Explicit --live required')
root=Path(__file__).resolve().parent
assert not (root/'critical-resources.jsonl').exists(),'one-run output directory'
plan={'baselineSeconds':30,'maxReplaySeconds':900,'cooldownSeconds':35,'maxAttempts':20,'minIntervalMs':30000,'admissionBytes':ADMIT_BYTES,'reserveBytes':RESERVE_BYTES,'maxSwapGrowthAndOutBytes':SWAP_BOUND,'criticalMaxAgeSeconds':2.5,'method':'Historical read-only replay; no production feature flags, restarts or authority changes','memoryLimit':'Sampled observer admission, not a kernel reservation or indefinite residency guarantee'}
(root/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')
prior=Path('docs/benchmarks/results/system-one-judges-2026-11-12-live-shadow');cfg=json.loads((prior/'nano-config.json').read_text());cfg['runtime']=cfg['runtime'].replace('event-following sidecar','guarded historical replay with independent critical sensor');(root/'nano-config.json').write_text(json.dumps(cfg,indent=2)+'\n')
metadata=json.loads((prior/'runtime-and-configuration.json').read_text())
for entry in metadata.values():
 path=Path(entry['path']);digest=hashlib.file_digest(path.open('rb'),'sha256').hexdigest();assert digest==entry['sha256'],'configuration or artifact drifted before experiment'
(root/'runtime-and-configuration.json').write_text(json.dumps(metadata,indent=2)+'\n')
status=subprocess.check_output(['launchctl','print','gui/501/dev.penumbra.local-judges'],text=True);pid=int(re.search(r'\n\s+pid = (\d+)',status)[1])
spec=importlib.util.spec_from_file_location('resources',Path('scripts/system-one-judge-resources.py'));resource=importlib.util.module_from_spec(spec);spec.loader.exec_module(resource)
stop=threading.Event();phase='baseline';events=[];child=None;aborted=False;reason=None;live_end=None;first_swap=None;first_outs=None;health_failures=0

def record(kind,**detail):
 e={'ts':time.time(),'kind':kind,**detail};events.append(e);(root/'lifecycle.json').write_text(json.dumps(events,indent=2)+'\n');print(json.dumps(e),flush=True)

def interrupt(signum,frame):raise InterruptedError('operator signal '+str(signum))
signal.signal(signal.SIGINT,interrupt);signal.signal(signal.SIGTERM,interrupt)

def slow_sample():
 with (root/'resources.jsonl').open('x') as output:
  while not stop.is_set():
   started=time.monotonic();sample_phase=phase
   row=resource.sample(pid,'http://127.0.0.1:51257/health')
   ps=[l.split() for l in subprocess.check_output(['ps','-axo','pid=,ppid=,rss=,%cpu='],text=True).splitlines() if l.strip()]
   tree=[{'pid':int(p),'ppid':int(pp),'rssBytes':int(rss)*1024,'cpuPercent':float(cpu)} for p,pp,rss,cpu in ps if int(p)==pid or int(pp)==pid]
   row.update(processes=tree,rssBytes=sum(x['rssBytes'] for x in tree),cpuPercent=sum(x['cpuPercent'] for x in tree),phase=sample_phase,sampleCompletedAt=time.time(),metricScope='Router plus direct children aggregate RSS/decaying ps CPU; GPU counters host-wide; not an atomic snapshot')
   output.write(json.dumps(row)+'\n');output.flush();stop.wait(max(0,1-(time.monotonic()-started)))
thread=threading.Thread(target=slow_sample,daemon=True);thread.start()
log=(root/'observer.stdout.log').open('x');started=time.monotonic();record('start',routerPid=pid,plan=plan)
try:
 with (root/'critical-resources.jsonl').open('x') as critical:
  while True:
   tick=time.monotonic();vm=resource.command(['vm_stat']);page=int(re.search(r'page size of (\d+)',vm)[1]);free=int(re.search(r'Pages free:\s+(\d+)',vm)[1]);inactive=int(re.search(r'Pages inactive:\s+(\d+)',vm)[1]);outs=int(re.search(r'Swapouts:\s+(\d+)',vm)[1]);swap=float(re.search(r'used = ([\d.]+)M',resource.command(['sysctl','vm.swapusage']))[1])*1024**2;measured=time.time()
   hstart=time.monotonic();health=None
   try:
    with urllib.request.urlopen('http://127.0.0.1:51257/health',timeout=1) as response:health=response.status
   except Exception:pass
   health_failures=0 if health==200 else health_failures+1
   if first_swap is None:first_swap=swap;first_outs=outs
   row={'criticalMeasuredAt':measured,'guardPublishedAt':time.time(),'availableFreeInactiveBytes':(free+inactive)*page,'swapUsedBytes':swap,'swapGrowthBytes':max(0,swap-first_swap),'swapoutBytes':max(0,(outs-first_outs)*page),'healthStatus':health,'healthWallMs':(time.monotonic()-hstart)*1000,'consecutiveHealthFailures':health_failures,'phase':phase,'liveEndsAtMs':live_end}
   admission,why=assess_guard(row,time.time(),phase);row.update(admission=admission,admissionReason=why,abort=admission=='abort')
   tmp=root/'guard-state.tmp';tmp.write_text(json.dumps(row)+'\n');os.replace(tmp,root/'guard-state.json');critical.write(json.dumps(row)+'\n');critical.flush()
   if admission=='abort':aborted=True;reason=why;record('guard_aborted',reason=reason);break
   if phase=='baseline' and time.monotonic()-started>=30:
    phase='live';live_end=int(time.time()*1000)+900000;record('replay_started',deadlineEpochMs=live_end)
   if child is None:
    child=subprocess.Popen(['bun',str(root/'replay.ts'),'--live'],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
   if phase=='live' and (child.poll() is not None or time.time()*1000>=live_end):
    if child.poll() is None:child.send_signal(signal.SIGTERM);child.wait(timeout=10)
    result=json.loads((root/'observer-run.json').read_text()) if (root/'observer-run.json').exists() else None
    outcome=observer_status(child.returncode,result);record('observer_finished',exitCode=child.returncode,outcome=outcome)
    if outcome=='interrupted':aborted=True;reason='observer_interrupted';break
    phase='cooldown';cooldown_end=time.monotonic()+35
   if phase=='cooldown' and time.monotonic()>=cooldown_end:break
   time.sleep(max(0,1-(time.monotonic()-tick)))
except BaseException as error:
 aborted=True;reason=type(error).__name__+': '+str(error);record('supervisor_error',reason=reason)
finally:
 if child and child.poll() is None:
  child.send_signal(signal.SIGTERM)
  try:child.wait(timeout=10)
  except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
 try:
  with urllib.request.urlopen('http://127.0.0.1:18944/models',timeout=3) as response:models=json.load(response)['data']
  native=next(x for x in models if x['id']=='d3-nano-eval')
  if native['status']['value'] in ['loaded','sleeping']:
   req=urllib.request.Request('http://127.0.0.1:18944/models/unload',data=json.dumps({'model':'d3-nano-eval'}).encode(),headers={'Content-Type':'application/json'})
   with urllib.request.urlopen(req,timeout=5) as response:record('native_only_unloaded',response=json.load(response))
  else:record('native_already_unloaded')
 except Exception as error:record('cleanup_observation',error=type(error).__name__)
 stop.set();thread.join(10);log.close()
 unchanged=all(hashlib.sha256(Path(metadata[x]['path']).read_bytes()).hexdigest()==metadata[x]['sha256'] for x in ['daemon','worker','local-judges','preset'])
 if not unchanged:aborted=True;reason='independent_configuration_drift'
 record('finished',aborted=aborted,abortReason=reason,servicesAndAuthorityUnchanged=unchanged,samplerStopped=not thread.is_alive())
if aborted:raise SystemExit(2)
