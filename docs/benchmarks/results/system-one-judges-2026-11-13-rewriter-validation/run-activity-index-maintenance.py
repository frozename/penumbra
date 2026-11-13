"""Explicit, serialized index-only maintenance; no daemon restart or migration."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

root=Path(__file__).resolve().parent
private=Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-rewriter-validation')
replica=sys.argv[1:]==['--test-replica']
if not replica and sys.argv[1:]!=['--live','--finish-activity-index']:
    raise SystemExit('Explicit --live --finish-activity-index required')
ci_path=root/'package-ci-validation.final.json'
if not replica:
    proof=json.loads(ci_path.read_text())
    assert proof['status']=='passed' and proof['ciExitCode']==0
    assert proof['sourceCommit']==subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
os.umask(0o077)
name='control-index-maintenance-activity'
report_path=root/(name+'.json')
if report_path.exists():raise SystemExit('Fresh evidence required')
events=[]
process=None

def record(kind,**details):
    event={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':kind,**details}
    events.append(event)
    report_path.write_text(json.dumps(events,indent=2)+'\n')
    print(json.dumps(event),flush=True)

def health():
    start=time.monotonic()
    try:
        with urllib.request.urlopen('http://127.0.0.1:51257/health',timeout=1)as response:
            data=json.load(response)
            return {'status':response.status,'wallMs':(time.monotonic()-start)*1000,'lagMs':data.get('lagMs')}
    except Exception as error:
        return {'status':None,'wallMs':(time.monotonic()-start)*1000,'error':type(error).__name__}

def interrupt(signum,frame):raise InterruptedError('operator signal '+str(signum))
signal.signal(signal.SIGINT,interrupt)
signal.signal(signal.SIGTERM,interrupt)
lock=(Path.home()/'.penumbra/locks/heavy-job.lock').open('a')
fcntl.flock(lock,fcntl.LOCK_EX)
try:
    record('lock_acquired',replica=replica,sourceCommit=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),indexSourceSha256=hashlib.sha256(Path('packages/core/src/db/control-plane-indexes.ts').read_bytes()).hexdigest())
    if not replica:
        # Lag is a trailing-minute max: require a clean admission window before write-lock work.
        deadline=time.monotonic()+180
        healthy=0
        while healthy<60:
            state=health()
            healthy=healthy+1 if state['status']==200 and state['wallMs']<250 and(state.get('lagMs')or 0)<250 else 0
            if time.monotonic()>deadline:raise RuntimeError('No healthy maintenance admission window')
            time.sleep(1)
        record('maintenance_admitted',health=state)
    for phase in ['before',3,'after']:
        output=private/(name+'.'+str(phase)+'.json')
        if output.exists():raise RuntimeError('Refusing evidence overwrite')
        command=['bun',str(root/'control-index-maintenance.ts')]
        command+=['--apply',str(phase)]if isinstance(phase,int)else['--inspect']
        command+=['--out',str(output)]
        command+=['--replica',str(private/'maintenance-test.sqlite')]if replica else['--live']
        samples=[]
        with(private/(name+'.'+str(phase)+'.log')).open('x')as log:
            process=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            deadline=time.monotonic()+(30 if isinstance(phase,int)else 15)
            while process.poll()is None:
                if time.monotonic()>deadline:raise RuntimeError('Owned maintenance deadline exceeded: '+str(phase))
                state=health();samples.append(state)
                if not replica and(state['status']!=200 or state['wallMs']>=250):
                    raise RuntimeError('Control health wall guard refused maintenance: '+str(phase))
                time.sleep(.1)
            code=process.wait()
        if code:raise RuntimeError('Maintenance child failed: '+str(phase)+'; inspect private log')
        result=json.loads(output.read_text())
        assert result['rowChanges']==0 and result['metadataUnchanged']
        record('phase_completed',phase=phase,reportSha256=hashlib.sha256(output.read_bytes()).hexdigest(),ddlMs=result.get('ddlMs'),healthSamples=samples)
    record('index_maintenance_complete',productionRestarted=False,modelRoutingChanged=False,dataRowsChanged=0,liveSchemaStampChanged=False,rollback='DROP INDEX only the four exact new index names, individually; do not migrate or downgrade metadata.')
except BaseException as error:
    record('aborted',reason=str(error))
    raise
finally:
    if process and process.poll()is None:
        os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
        record('owned_child_stopped',signal='SIGKILL',uncommittedDdlRollsBack=True)
    fcntl.flock(lock,fcntl.LOCK_UN);lock.close()
