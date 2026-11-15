from pathlib import Path
import subprocess,json,time,sys,importlib.util,threading,urllib.request
sys.dont_write_bytecode=True
if sys.argv[1:]!=['--live']:raise SystemExit('Explicit --live required')
r=Path(__file__).resolve().parent
for _ in range(120):
 try:
  with urllib.request.urlopen('http://127.0.0.1:18944/health',timeout=1) as f:assert f.status==200
  break
 except Exception:time.sleep(.25)
else:raise RuntimeError('managed router readiness')
status=subprocess.check_output(['launchctl','print','gui/501/dev.penumbra.local-judges'],text=True);pid=next(int(l.split('=')[1]) for l in status.splitlines() if l.strip().startswith('pid ='))
spec=importlib.util.spec_from_file_location('resources',Path('scripts/system-one-judge-resources.py'));mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
done=threading.Event()
def sample():
 with (r/'bounded-resources.jsonl').open('x') as output:
  while not done.is_set():
   t=time.monotonic();row=mod.sample(pid,'http://127.0.0.1:51257/health')
   rows=[list(map(float,l.split())) for l in subprocess.check_output(['ps','-axo','pid=,ppid=,rss=,%cpu='],text=True).splitlines() if l.strip()]
   tree=[{'pid':int(p),'ppid':int(pp),'rssBytes':int(rss)*1024,'cpuPercent':cpu} for p,pp,rss,cpu in rows if int(p)==pid or int(pp)==pid]
   row.update(processes=tree,rssBytes=sum(x['rssBytes'] for x in tree),cpuPercent=sum(x['cpuPercent'] for x in tree),metricScope='router plus direct children aggregate RSS/decaying ps CPU')
   output.write(json.dumps(row)+'\n');output.flush();done.wait(max(0,1-(time.monotonic()-t)))
thread=threading.Thread(target=sample);thread.start()
try:
 run=subprocess.run(['bun','scripts/system-one-judge-bench.ts','--config',str(r/'nano-bounded-config.json'),'--fixtures','/Volumes/AI-DATA/maestro/bench/system-one-judges-20261111/review-200/ai-reviewed-judges-v2.jsonl','--out',str(r/'nano-bounded'),'--live'])
 if run.returncode:raise RuntimeError('benchmark failed')
finally:done.set();thread.join(10)
