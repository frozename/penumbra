from pathlib import Path
import datetime,json,math,statistics,subprocess,sys
sys.dont_write_bytecode=True
from guard import observer_status
root=Path(__file__).resolve().parent
run=json.loads((root/'observer-run.json').read_text());life=json.loads((root/'lifecycle.json').read_text());rows=[json.loads(l) for l in (root/'observations.jsonl').read_text().splitlines() if l.strip()];samples=[json.loads(l) for l in (root/'resources.jsonl').read_text().splitlines() if l.strip()];critical=[json.loads(l) for l in (root/'critical-resources.jsonl').read_text().splitlines() if l.strip()]
finished=next(x for x in life if x['kind']=='observer_finished');begin=next(x['ts'] for x in life if x['kind']=='replay_started');end=finished['ts']
for name,start,stop in [('baseline',life[0]['ts'],begin),('replay',begin,end)]:
 interval={'startedAt':datetime.datetime.fromtimestamp(start,datetime.timezone.utc).isoformat(),'elapsedMs':(stop-start)*1000};(root/(name+'-interval.json')).write_text(json.dumps(interval,indent=2)+'\n')
 # Exclude samples whose multi-command collection spans a phase boundary.
 selected=[r for r in samples if r['ts']>=start and r['sampleCompletedAt']<=stop]
 sample_path=root/(name+'-samples.jsonl');sample_path.write_text(''.join(json.dumps(x)+'\n' for x in selected))
 subprocess.run(['python3','scripts/system-one-judge-resource-summary.py','--run',str(root/(name+'-interval.json')),'--samples',str(sample_path),'--out',str(root/(name+'-resources.json'))],check=True)
lat=sorted(x['latencyMs'] for x in rows if x['failure'] is None);observations=[]
for r in rows:
 counted=[v for v in r['incumbentVotes'] or [] if not v.get('abstained') and not v.get('error_class')]
 observations.append({'subjectId':r['subjectId'],'candidate':r['candidatePromote'],'countedIncumbentVotes':len(counted),'sufficientRecordedQuorum':len(counted)>=2,'availableSeatDisagreements':sum(r['candidatePromote']!=v['promote'] for v in counted) if r['candidatePromote'] is not None else None})
a={'status':observer_status(finished['exitCode'],run),'resourceGuardAborted':life[-1]['aborted'],'attempts':len(rows),'answered':len(lat),'failures':[r['failure'] for r in rows if r['failure'] is not None],'latencyP50Ms':statistics.median(lat) if lat else None,'latencyP95Ms':lat[math.ceil(.95*len(lat))-1] if lat else None,'candidatePromotions':sum(r['candidatePromote'] is True for r in rows),'allShadowUnapplied':all(r['mode']=='shadow' and r['applied'] is False for r in rows),'actualQualityLabels':0,'quorumComparableCases':sum(x['sufficientRecordedQuorum'] for x in observations),'cases':observations,'criticalSensor':{'samples':len(critical),'healthFailures':sum(x['healthStatus']!=200 for x in critical),'minAvailableFreeInactiveBytes':min(x['availableFreeInactiveBytes'] for x in critical),'maxSwapGrowthBytes':max(x['swapGrowthBytes'] for x in critical),'maxSwapoutBytes':max(x['swapoutBytes'] for x in critical),'admissionWaitSamples':sum(x['admission']=='wait' for x in critical),'maxCriticalIntervalMs':max((b['criticalMeasuredAt']-a['criticalMeasuredAt'])*1000 for a,b in zip(critical,critical[1:]))},'limitations':['Historical replay, including reused cases; not contemporary shadow or new quality acceptance','No labels; no F1/Brier/calibration/ground-truth inference','Recorded ballots not simultaneous incumbent calls; insufficient quorum is not a NO','Paced30s minimum; not requests/s capacity','Other host activity uncontrolled; concurrent aggregate query recorded separately','Sampled experimental admission is not a kernel memory reservation;1Hz samples can miss peaks','Full GPU/resource sampling decoupled from critical admission sensor; boundary-spanning samples excluded']}
(root/'analysis.json').write_text(json.dumps(a,indent=2)+'\n');print(json.dumps(a,indent=2))
