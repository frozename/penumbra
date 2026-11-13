import datetime
import hashlib
import json
import math
from pathlib import Path
import statistics

root = Path(__file__).resolve().parent
private = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-span-selection')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def jsonl(name):
    return [json.loads(line) for line in (private/name).read_text().splitlines()]


def percentile(values, quantile=.95):
    return sorted(values)[math.ceil(len(values)*quantile)-1] if values else None


def timing(values):
    return {'p50':statistics.median(values) if values else None,'p95NearestRank':percentile(values),'max':max(values) if values else None}


inputs = {row['id']:row for row in jsonl('heldout.jsonl')}
labels = {row['caseId']:row for row in jsonl('labels-adjudicated.jsonl')}
key = json.loads((private/'output-review-key.json').read_text())
packet = {row['caseId']:row for row in jsonl('output-review-packet.jsonl')}
grades = jsonl('output-review-adjudicated.jsonl')
grade_map = {(row['caseId'],row['anonymousRun']):row for row in grades}
assert len(inputs) == len(labels) == len(packet) == 38
assert len(grade_map) == len(grades) == 38*len(key) == 228
results = []
public_cases = []
for alias,group in key.items():
    profile,variant = group['profile'],group['variant']
    data = json.loads((private/(profile+'.json')).read_text())
    rows = [row for row in data['rows'] if row['variant'] == variant]
    assert len(rows) == 38 and len({r['id'] for r in rows}) == 38 and data['applied'] is False
    cohorts = {}
    for kind in ['historical','controlled']:
        chosen = [row for row in rows if inputs[row['id']]['kind'] == kind]
        totals = dict(positiveCases=0,negativeCases=0,uncertainCases=0,validArrays=0,abstentions=0,proposals=0,mechanicallyPromotable=0,supportedProposals=0,eligibleProposals=0,safePromotable=0,expectedFactInstances=0,coveredFactInstances=0,safelyCoveredFactInstances=0,negativeCasesWithPromotableProposals=0,validFalseVetoes=0,positiveAbstentions=0,negativeAbstentions=0,positiveCasesWithSafeProposal=0,tp=0,fp=0,tn=0,fnAnswered=0)
        for row in chosen:
            label = labels[row['id']]
            grade = grade_map[(row['id'],alias)]
            memories = row.get('value',[])
            review_run = next(run for run in packet[row['id']]['runs'] if run['anonymousRun'] == alias)
            assert row['inputSha256'] == grade['inputSha256'] == label['inputSha256']
            assert grade['abstention'] == ('error' in row)
            assert grade['expectedFactCount'] == len(label['facts'])
            assert len(grade['memories']) == len(memories)
            covered,safe_covered = set(),set()
            for index,memory in enumerate(grade['memories']):
                assert memory['index'] == index and memory['promotable'] == review_run['mechanicallyPromotable'][index]
                assert all(type(memory[k]) is bool for k in ['supported','policyEligible','promotable'])
                assert len(memory['coveredFactIndices']) == len(set(memory['coveredFactIndices']))
                assert all(type(i) is int and 0 <= i < len(label['facts']) for i in memory['coveredFactIndices'])
                covered.update(memory['coveredFactIndices'])
                safe = memory['supported'] and memory['policyEligible'] and memory['promotable']
                if safe:
                    safe_covered.update(memory['coveredFactIndices'])
                totals['mechanicallyPromotable'] += memory['promotable']
                totals['supportedProposals'] += memory['supported']
                totals['eligibleProposals'] += memory['policyEligible']
                totals['safePromotable'] += safe
            assert set(grade['coveredFactIndices']) == covered
            public_cases.append({'profile':profile,'variant':variant,'caseId':row['id'],'kind':kind,'inputSha256':row['inputSha256'],'label':label['verdict'],'abstention':grade['abstention'],'latencyMs':row['latencyMs'],'expectedFacts':len(label['facts']),'coveredFactIndices':sorted(covered),'safelyCoveredFactIndices':sorted(safe_covered),'memories':[{k:m[k] for k in ['index','promotable','supported','policyEligible','coveredFactIndices']} for m in grade['memories']]})
            totals['proposals'] += len(memories)
            totals['validArrays'] += 'value' in row
            totals['abstentions'] += 'error' in row
            totals['coveredFactInstances'] += len(covered)
            totals['safelyCoveredFactInstances'] += len(safe_covered)
            totals['expectedFactInstances'] += len(label['facts'])
            predicted = any(memory['promotable'] for memory in grade['memories'])
            has_safe = any(memory['promotable'] and memory['supported'] and memory['policyEligible'] for memory in grade['memories'])
            if label['verdict'] == 'positive':
                totals['positiveCases'] += 1
                totals['positiveCasesWithSafeProposal'] += has_safe
                totals['positiveAbstentions'] += grade['abstention']
                totals['validFalseVetoes'] += not grade['abstention'] and not predicted
                if not grade['abstention']:
                    totals['tp' if predicted else 'fnAnswered'] += 1
            elif label['verdict'] == 'negative':
                totals['negativeCases'] += 1
                totals['negativeCasesWithPromotableProposals'] += predicted
                totals['negativeAbstentions'] += grade['abstention']
                if not grade['abstention']:
                    totals['fp' if predicted else 'tn'] += 1
            else:
                totals['uncertainCases'] += 1
        tp,fp,fn = totals['tp'],totals['fp'],totals['fnAnswered']
        totals.update(safeProposalPrecision=totals['safePromotable']/totals['mechanicallyPromotable'] if totals['mechanicallyPromotable'] else None,
                      safeFactRecall=totals['safelyCoveredFactInstances']/totals['expectedFactInstances'] if totals['expectedFactInstances'] else None,
                      decisionPrecisionAnswered=tp/(tp+fp) if tp+fp else None,
                      decisionRecallAnswered=tp/(tp+fn) if tp+fn else None,
                      decisionF1Answered=2*tp/(2*tp+fp+fn) if 2*tp+fp+fn else None,
                      falsePromotionRateAllNegatives=fp/totals['negativeCases'] if totals['negativeCases'] else None,
                      validFalseVetoRateAllPositives=totals['validFalseVetoes']/totals['positiveCases'] if totals['positiveCases'] else None,
                      latencyMsAll=timing([row['latencyMs'] for row in chosen]),
                      latencyMsValidArrays=timing([row['latencyMs'] for row in chosen if 'value' in row]),
                      serialObservedCasesPerSecond=len(chosen)/(sum(row['latencyMs'] for row in chosen)/1000))
        cohorts[kind] = totals
    calls = [call for call in data['calls'] if call['variant'] == variant]
    statuses = {}
    for call in calls:
        status = str(call.get('status','transport-error'));statuses[status] = statuses.get(status,0)+1
    results.append({'profile':profile,'variant':variant,'model':data['model'],'rawSha256':digest(private/(profile+'.json')),'cohorts':cohorts,'calls':len(calls),'httpStatuses':statuses,'tokenTruncatedReplies':sum(c.get('finishReason') == 'length' for c in calls),'maxPromptTokens':max(c.get('usage',{}).get('prompt_tokens',0) for c in calls),'maxCompletionTokens':max(c.get('usage',{}).get('completion_tokens',0) for c in calls),'errors':[{'caseId':r['id'],'error':r['error']} for r in rows if 'error' in r]})

resource_results = []
for profile in ['test-granite-v3','test-z13-v3','test-qwen2b-v3']:
    samples = jsonl(profile+'-resources.jsonl')
    data = json.loads((private/(profile+'.json')).read_text())
    start = datetime.datetime.fromisoformat(data['startedAt'].replace('Z','+00:00')).timestamp()
    end = datetime.datetime.fromisoformat(data['updatedAt'].replace('Z','+00:00')).timestamp()
    stamp = lambda row:row.get('clientNormalizedTs',row.get('ts',row.get('measuredAt')))
    active = [r for r in samples if start <= stamp(r) <= end]
    assert active
    result = {'profile':profile,'samples':len(active),'rawSha256':digest(private/(profile+'-resources.jsonl')),'intervalCoverage':(stamp(active[-1])-stamp(active[0]))/(end-start)}
    if profile != 'test-z13-v3':
        result.update(method='One-Hz process RSS; not physical footprint or total unified memory. Host GPU counters are separate and non-additive. ps CPU is the displayed process percentage, not instantaneous interval utilization.',
                      rssMedianBytes=statistics.median(r['rssBytes'] for r in active),rssPeakBytes=max(r['rssBytes'] for r in active),minFreePlusInactiveBytes=min(r['freePlusInactiveBytes'] for r in active),swapGrowthBytes=active[-1]['swapUsedBytes']-active[0]['swapUsedBytes'],swapins=active[-1]['swapins']-active[0]['swapins'],swapouts=active[-1]['swapouts']-active[0]['swapouts'],healthFailures=sum(r['healthStatus'] != 200 for r in active),healthP95Ms=percentile([r['healthWallMs'] for r in active]),psCpuPeakPercent=max(r['cpuPercent'] for r in active),hostGpuInUsePeakBytes=max(r['systemGpuInUseBytes'] or 0 for r in active),hostGpuAllocatedPeakBytes=max(r['systemGpuAllocatedBytes'] or 0 for r in active))
    else:
        cpu = [100*(b['gufo']['cpuTicks']-a['gufo']['cpuTicks'])/b['cpuClockTicksPerSecond']/(b['measuredAt']-a['measuredAt']) for a,b in zip(active,active[1:])]
        gpu = [float(v) for r in active for v in r['gpuBusyPercent'].values() if v is not None and str(v).isdigit()]
        temperatures = [r['maxTemperatureC'] for r in active if r['maxTemperatureC'] is not None]
        result.update(method='One-Hz Gufo process RSS excludes GPU/shared allocations; not total footprint or incremental request memory. CPU tick deltas; GPU/thermal counters are host-wide. Remote timestamps normalized with bounded roundtrip clock calibration.',
                      rssMedianBytes=statistics.median(r['gufo']['rssBytes'] for r in active),rssPeakBytes=max(r['gufo']['rssBytes'] for r in active),minAvailableBytes=min(r['availableBytes'] for r in active),swapGrowthBytes=max(r['swapGrowthBytes'] for r in active),swapoutBytes=max(r['swapoutBytes'] for r in active),maxMemoryFullAvg10=max(r['memoryFullAvg10'] for r in active),healthFailures=sum(r['gufoHealthFailures'] > 0 for r in active),healthP95Ms=percentile([r['gufoHealthMs'] for r in active]),maxProcessingSlots=max(r['processingSlots'] for r in active),cpuIntervalPeakPercent=max(cpu) if cpu else None,readableGpuBusyPeakPercent=max(gpu) if gpu else None,maxReadableThermalZoneC=max(temperatures) if temperatures else None)
    resource_results.append(result)

report = {'method':'Pre-inference frozen 14 historical +24 controlled cases; independent AI source labels and model-blind proposal grades. Populations reported separately. Exact copy constrains authorship, not truth or eligibility.',
          'qualityUnits':'Proposal precision and fact recall have different units and are not combined into F1. Separate answered-only binary case decision uses any mechanically promotable proposal; it can count an unsupported proposal as a positive and must be read alongside safe precision/recall. Abstentions are never true negatives; report their counts. Uncertain case excluded from binary quality.',
          'notMeasured':['Brier/ECE: generated arrays/ranges provide no model probability.','Realistic coding contention, load-isolation and sustained concurrent capacity.','Historical execution from code checks; population error bounds from purposive small samples.'],
          'provenanceSha256':{name:digest(private/name) for name in ['heldout.jsonl','labels-adjudicated.jsonl','output-review-packet.jsonl','output-review-key.json','output-review-a.jsonl','output-review-b.jsonl','output-review-adjudicated.jsonl','output-adjudication.json','label-adjudication.json']},
          'runs':sorted(results,key=lambda r:(r['profile'],r['variant'])),'modelResourcesAcrossBothVariants':resource_results,'productionAuthorityChanged':False,'sourceFlagActivated':False,'packageCodeChangedInThisStudy':False}
(root/'case-results.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in sorted(public_cases,key=lambda r:(r['profile'],r['variant'],r['caseId']))))
(root/'span-selection-summary.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps([{'profile':r['profile'],'variant':r['variant'],'cohorts':{k:{key:c[key] for key in ['safePromotable','mechanicallyPromotable','safelyCoveredFactInstances','expectedFactInstances','negativeCasesWithPromotableProposals','abstentions']} for k,c in r['cohorts'].items()}} for r in report['runs']],indent=2))
