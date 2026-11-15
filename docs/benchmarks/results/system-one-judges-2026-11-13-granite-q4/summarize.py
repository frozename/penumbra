import datetime
import hashlib
import json
import math
from pathlib import Path
import statistics

root = Path(__file__).resolve().parent
private = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-granite-q4')
runs = []
for name in ['granite-q4-canary','granite-q8-canary-retry']:
    path = private/(name+'.json')
    data = json.loads(path.read_text())
    assert len(data['rows']) == 31 and data['applied'] is False
    samples_path = private/(name+'-resources.jsonl')
    samples = [json.loads(line) for line in samples_path.read_text().splitlines()]
    start = datetime.datetime.fromisoformat(data['startedAt'].replace('Z','+00:00')).timestamp()
    end = datetime.datetime.fromisoformat(data['updatedAt'].replace('Z','+00:00')).timestamp()
    active = [row for row in samples if start <= row['ts'] <= end]
    assert active
    controls = [row for row in data['rows'] if row['workload'] != 'controlled-extraction']
    controlled = [row for row in data['rows'] if row['workload'] == 'controlled-extraction']
    assert len(controls) == 7 and len(controlled) == 24
    result = {
        'run':name,'modelAlias':data['model'],
        'rawSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'cases':31,
        'controlsPassed':sum(row.get('controlPassed') is True for row in controls),'controls':7,
        'controlOutcomes':[{'caseId':row['id'],'workload':row['workload'],'passed':row.get('controlPassed'),'error':row.get('error'),'latencyMs':row['latencyMs']} for row in controls],
        'controlledCases':24,'controlledAcceptedArrays':sum('value' in row for row in controlled),
        'controlledProposals':sum(len(row.get('value',[])) for row in controlled),
        'controlledMechanicallyPromotable':sum(memory.get('promote') is not False and memory.get('is_episodic') is not True and memory.get('obs_type') != 'standing_brief' and (len(memory['body'].strip()) >= 80 or (memory.get('depth') or 0) >= 2) for row in controlled for memory in row.get('value',[])),
        'calls':len(data['calls']),'http200':sum(row['status'] == 200 for row in data['calls']),
        'tokenTruncations':sum(row['finishReason'] == 'length' for row in data['calls']),
        'temperatures':sorted({str(row.get('temperature')) for row in data['calls']}),
        'rssMedianBytes':statistics.median(row['rssBytes'] for row in active),
        'rssPeakBytes':max(row['rssBytes'] for row in active),'sampleCount':len(active),
        'swapGrowthBytes':active[-1]['swapUsedBytes']-active[0]['swapUsedBytes'],
        'healthFailures':sum(row['healthStatus'] != 200 for row in active),
        'healthP95Ms':sorted(row['healthWallMs'] for row in active)[math.ceil(.95*len(active))-1],
        'maxTrailingMinuteDaemonLagMs':max(row.get('daemonLagMs') or 0 for row in active),
        'controlledLatencyMs':{'p50':statistics.median(row['latencyMs'] for row in controlled),'p95':sorted(row['latencyMs'] for row in controlled)[math.ceil(.95*24)-1]},
        'resourcesSha256':hashlib.sha256(samples_path.read_bytes()).hexdigest(),
    }
    runs.append(result)

summary = {
    'method':'Exploratory matched-context quantization canary, repeated exposed controls, actual factory temperatures. Not hidden quality acceptance or decoder source-span trial.',
    'runs':runs,
    'priorAbort':{'run':'granite-q8-canary','beforeInference':True,'reason':'Three-second daemon preflight health timeout after CI; no model started/no quality result.'},
    'memorySavingPeakProfileFraction':1-runs[0]['rssPeakBytes']/runs[1]['rssPeakBytes'],
    'caveats':[
        'One-Hz process RSS, not total unified memory or hard-real-time peak.',
        'Q4 executed before completed Q8 retry; filesystem cache and brief/refiner sampling uncontrolled.',
        'Health lag is trailing60-second maximum, carrying an earlier19.3-second post-CI event into Q4 samples. Healthy HTTP wall times do not negate that operational issue.',
        'Neither profile yields promotable controlled memories; empty output does not establish quality.',
        'Six/seven coarse contract controls are not semantic non-inferiority.',
        'Original full rewriter benchmark fixture files unavailable.',
    ],
    'productionActivated':False,
}
(root/'quantization-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({'runs':[{'run':row['run'],'peakRssGiB':row['rssPeakBytes']/1024**3,'controlsPassed':row['controlsPassed']} for row in runs],'peakReductionFraction':summary['memorySavingPeakProfileFraction']}))
