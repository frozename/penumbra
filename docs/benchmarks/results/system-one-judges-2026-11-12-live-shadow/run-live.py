from pathlib import Path
import sys
sys.dont_write_bytecode=True
import datetime,hashlib,importlib.util,json,os,re,signal,subprocess,time,urllib.request
if sys.argv[1:]!=['--live']:raise SystemExit('Explicit --live required')
root=Path(__file__).resolve().parent
assert not (root/'resources.jsonl').exists(), 'one-run output directory'
now=lambda: datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
plan={'dbPath':str(Path.home()/'.penumbra/db.sqlite'),'baselineSeconds':60,'liveSeconds':900,'cooldownSeconds':35,'maxAttempts':10,'minIntervalMs':30000,'maxEventAgeMs':180000,'admitAvailableBytes':int(5.5*1024**3),'abortAvailableBytes':2*1024**3,'maxSwapGrowthBytes':256*1024**2,'maxSwapoutBytes':256*1024**2,'healthConsecutiveFailureLimit':2,'guardSampleMaxAgeMs':2500,'authority':'none; sidecar only; no daemon restart or feature flag change','memoryCaveat':'Strict per-request observer admission and sampled abort bounds; not a kernel reservation or proof of indefinite co-residency.'}
(root/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')
base=Path('docs/benchmarks/results/system-one-judges-2026-11-12-resume')
cfg=json.loads((base/'nano-bounded-config.json').read_text());cfg['runtime']='llama.cpp2cbe0ec HTTP-only Metal; supervised one-hot router; native ctx/batch/ubatch2048; threads2; cache0; idle30s; P4 corrected source4fe live; current Granite route18944; event-following sidecar, no source changes'
(root/'nano-config.json').write_text(json.dumps(cfg,indent=2)+'\n')
status=subprocess.check_output(['launchctl','print','gui/501/dev.penumbra.local-judges'],text=True);pid=int(re.search(r'\n\s+pid = (\d+)',status)[1])
metadata={}
for role in ['daemon','worker','local-judges']:
 p=Path.home()/('Library/LaunchAgents/dev.penumbra.'+role+'.plist');metadata[role]={'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
for label,path,expected in [('nano',Path.home()/'.local/share/penumbra/inference/models/vllm-d3-nano-GGUF/vllm-d3-nano-Q8_0.gguf','a4d7563d9622a4c34cc7276a3381c3e27a25bbf8d4c0f5ee2f1404fc89ce2ab9'),('runtime',Path.home()/'.local/share/penumbra/inference/system-one-llama/2cbe0ec-http-only/bin/llama-server','a9990314838bafcbaa2601c41a375eb764489084ff2469b0770a7d47a33da104')]:
 digest=hashlib.file_digest(path.open('rb'),'sha256').hexdigest();assert digest==expected;metadata[label]={'path':str(path),'sha256':digest,'bytes':path.stat().st_size}
ini=Path.home()/'.config/penumbra/inference/local-judges-2cbe0ec.ini';text=ini.read_text();assert 'ctx-size = 2048\nbatch-size = 2048\nubatch-size = 2048' in text
metadata['preset']={'path':str(ini),'sha256':hashlib.sha256(ini.read_bytes()).hexdigest()}
(root/'runtime-and-configuration.json').write_text(json.dumps(metadata,indent=2)+'\n')
spec=importlib.util.spec_from_file_location('resources',Path('scripts/system-one-judge-resources.py'));resource=importlib.util.module_from_spec(spec);spec.loader.exec_module(resource)
phase='baseline';started=time.monotonic();live_since=None;live_end=None;baseline_swap=None;baseline_swapouts=None;health_failures=0;child=None;aborted=False;abort_reason=None
log=(root/'observer.stdout.log').open('x');samples=(root/'resources.jsonl').open('x');events=[]
def record(kind,**details):
 e={'ts':time.time(),'kind':kind,**details};events.append(e);(root/'lifecycle.json').write_text(json.dumps(events,indent=2)+'\n');print(json.dumps(e),flush=True)
def call(path,body=None):
 req=urllib.request.Request('http://127.0.0.1:18944'+path,data=json.dumps(body).encode() if body else None,headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=5) as response:return json.load(response)
record('start',routerPid=pid,baselineSeconds=60,liveSeconds=900)
try:
 while True:
  t=time.monotonic();row=resource.sample(pid,'http://127.0.0.1:51257/health')
  vm=resource.command(['vm_stat']);page=int(re.search(r'page size of (\d+)',vm)[1]);free=int(re.search(r'Pages free:\s+(\d+)',vm)[1]);inactive=int(re.search(r'Pages inactive:\s+(\d+)',vm)[1]);row['availableFreeInactiveBytes']=(free+inactive)*page
  ps=[l.split() for l in subprocess.check_output(['ps','-axo','pid=,ppid=,rss=,%cpu='],text=True).splitlines() if l.strip()];tree=[{'pid':int(p),'ppid':int(pp),'rssBytes':int(rss)*1024,'cpuPercent':float(cpu)} for p,pp,rss,cpu in ps if int(p)==pid or int(pp)==pid]
  row.update(processes=tree,rssBytes=sum(p['rssBytes'] for p in tree),cpuPercent=sum(p['cpuPercent'] for p in tree),metricScope='router plus direct children aggregate RSS and decaying ps CPU',phase=phase)
  if baseline_swap is None:baseline_swap=row['swapUsedBytes'];baseline_swapouts=row['swapouts']
  health_failures=health_failures+1 if row['healthStatus']!=200 else 0
  reason=None
  if row['healthStatus']!=200 and phase=='baseline':reason='baseline_http_health_failure'
  if health_failures>=2:reason='two_consecutive_http_failures'
  if row['availableFreeInactiveBytes']<plan['abortAvailableBytes']:reason='available_memory_below2GiB'
  if row['swapUsedBytes'] is None or row['swapouts'] is None:reason='unavailable_resource_metrics'
  elif row['swapUsedBytes']-baseline_swap>plan['maxSwapGrowthBytes'] or (row['swapouts']-baseline_swapouts)*page>plan['maxSwapoutBytes']:reason='swap_growth_or_outs_exceeded256MiB'
  if not tree or tree[0]['pid']!=pid:reason='router_identity_lost'
  if reason and not aborted:
   aborted=True;abort_reason=reason;record('guard_aborted',reason=reason)
   if child and child.poll() is None:child.send_signal(signal.SIGTERM)
  state={**row,'abort':aborted,'abortReason':abort_reason,'liveSince':live_since,'liveEndsAtMs':live_end,'phase':'aborted' if aborted else phase}
  tmp=root/'guard-state.tmp';tmp.write_text(json.dumps(state)+'\n');os.replace(tmp,root/'guard-state.json');samples.write(json.dumps(row)+'\n');samples.flush()
  if aborted:break
  if phase=='baseline' and time.monotonic()-started>=60:
   phase='live';live_since=now();live_end=int(time.time()*1000)+900000;record('live_phase_started',since=live_since,deadlineEpochMs=live_end)
   child=subprocess.Popen(['bun',str(root/'follow-live.ts'),'--live'],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  elif phase=='live' and (time.time()*1000>=live_end or (child is not None and child.poll() is not None)):
   if child and child.poll() not in [None,0]:raise RuntimeError('observer exited nonzero')
   phase='cooldown';cooldown_end=time.monotonic()+35;record('live_phase_ended')
  elif phase=='cooldown' and time.monotonic()>=cooldown_end:break
  time.sleep(max(0,1-(time.monotonic()-t)))
except BaseException as error:
 aborted=True;abort_reason=type(error).__name__+': '+str(error);record('supervisor_error',reason=abort_reason)
finally:
 if child and child.poll() is None:
  child.send_signal(signal.SIGTERM)
  try:child.wait(timeout=10)
  except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
 try:
  response=call('/models/unload',{'model':'d3-nano-eval'});record('native_only_unloaded',response=response)
 except Exception as error:record('native_unload_response',error=type(error).__name__)
 for role,entry in metadata.items():
  if role in ['daemon','worker','local-judges']:
   assert hashlib.sha256(Path(entry['path']).read_bytes()).hexdigest()==entry['sha256'], 'service configuration drifted independently'
 samples.close();log.close()
 record('finished',aborted=aborted,abortReason=abort_reason,phase=phase,modelStatuses=[{'id':m['id'],'status':m['status']['value']} for m in call('/models')['data']],servicesAndAuthorityChanged=False)
