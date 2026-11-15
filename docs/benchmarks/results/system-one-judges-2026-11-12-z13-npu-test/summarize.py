import datetime
import json
from pathlib import Path
import sys

from trial_guard import classify_run, coexistence_status

out = Path(sys.argv[1])
fixtures = [json.loads(line) for line in Path(sys.argv[2]).read_text().splitlines() if line]
def load(name):
    path = out / name
    return json.loads(path.read_text()) if path.exists() else None
run, guard = load('run.json'), load('guard.json')
status = classify_run(run, guard, len(fixtures))
intervals = []
if run:
    start = datetime.datetime.fromisoformat(run['startedAt'].replace('Z', '+00:00')).timestamp()
    intervals = [(start+r['startedOffsetMs']/1000, start+(r['startedOffsetMs']+r['latencyMs'])/1000)
                 for r in run['rows'] if r.get('error') is None]
phases = [load('gufo-'+phase+'.json') for phase in ['before', 'during', 'after']]
coexistence, overlap = coexistence_status(phases, intervals)
result = dict(status=status, expected=len(fixtures), attempted=len(run['rows']) if run else 0,
              answered=sum(r['error'] is None for r in run['rows']) if run else 0,
              admissionFloorIgnored=True, authority='none',
              gufoDuringProbesOverlappingCandidate=overlap,
              coexistenceStatus=coexistence,
              qualityAcceptance=False, guard=guard)
(out/'trial-status.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
if status != 'completed_runtime_replay':
    raise SystemExit(1)
