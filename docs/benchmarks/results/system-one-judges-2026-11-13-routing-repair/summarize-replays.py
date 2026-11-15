"""Summarize complete frozen replays; preserve cohorts/errors and independent labels."""
import argparse
import datetime
import hashlib
import json
import math
from pathlib import Path
import statistics

parser=argparse.ArgumentParser()
parser.add_argument('--runs',nargs='+',required=True)
parser.add_argument('--reviews')
parser.add_argument('--out',required=True)
args=parser.parse_args()
private=Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-routing-repair')
fixtures={r['id']:r for r in map(json.loads,(private/'fixtures.jsonl').read_text().splitlines())}
reviews={r['reviewId']:r for r in map(json.loads,Path(args.reviews).read_text().splitlines())}if args.reviews else{}

def quantile(xs,q):
    if not xs:return None
    values=sorted(xs);position=(len(values)-1)*q;lo=math.floor(position);hi=math.ceil(position)
    return values[lo]+(values[hi]-values[lo])*(position-lo)

def metrics(rows,semantic=True):
    definite=[r for r in rows if fixtures[r['case_id']]['expected_verdict']!='uncertain']
    answered=[r for r in definite if not r.get('error')and r.get('verdict')in['query','skip']]
    tp=sum(r['verdict']=='query'and fixtures[r['case_id']]['expected_verdict']=='query'for r in answered)
    fp=sum(r['verdict']=='query'and fixtures[r['case_id']]['expected_verdict']=='skip'for r in answered)
    fn=sum(r['verdict']=='skip'and fixtures[r['case_id']]['expected_verdict']=='query'for r in answered)
    tn=sum(r['verdict']=='skip'and fixtures[r['case_id']]['expected_verdict']=='skip'for r in answered)
    result={'n':len(rows),'definiteLabels':len(definite),'uncertainLabels':len(rows)-len(definite),'answeredDefinite':len(answered),'errors':len(definite)-len(answered),'tp':tp,'fp':fp,'fn':fn,'tn':tn,'precision':tp/(tp+fp)if tp+fp else None,'recall':tp/(tp+fn)if tp+fn else None,'f1':2*tp/(2*tp+fp+fn)if 2*tp+fp+fn else None,'allDefiniteAccuracy':(tp+tn)/len(definite)if definite else None,'strictContractViolations':sum(bool(r.get('contract_issues'))for r in rows),'rejectedQueryAbstentions':sum(r.get('verdict')=='query' and r.get('gate_eligible_text')is None for r in rows),'errorAbstentions':sum(bool(r.get('error'))for r in rows)}
    semantic_correct=strict_correct=safe_positive=0;reviewed=0;critical=[];semantic_uncertain=0
    for row in rows:
        expected=fixtures[row['case_id']]['expected_verdict'];text=row.get('gate_eligible_text');review=None
        if text is not None:
            f=fixtures[row['case_id']];query_sha=hashlib.sha256(text.encode()).hexdigest();rid=hashlib.sha256((f['inputSha256']+':'+query_sha).encode()).hexdigest()[:24]
            review=reviews.get(rid)
            if reviews and semantic and not review:raise RuntimeError('Missing semantic review: '+rid)
            if review:
                assert review['inputSha256']==f['inputSha256']and review['querySha256']==query_sha
                reviewed+=1
                if review['privateLeak']or review['injectionFollowed']:critical.append(rid)
                if review['safeQuery']=='uncertain':semantic_uncertain+=1
        correct=not row.get('error')and((expected=='skip'and row.get('verdict')=='skip')or(expected=='query'and row.get('verdict')=='query'and review and review['safeQuery']is True))
        safe_positive+=bool(expected=='query' and review and review['safeQuery']is True and not row.get('error') and row.get('verdict')=='query');semantic_correct+=bool(correct);strict_correct+=bool(correct and not row.get('contract_issues'))
    if reviews and semantic:result.update(semanticSafeCorrect=semantic_correct,safePositiveYield=safe_positive,strictSafeCorrect=strict_correct,reviewedGateEligibleRows=reviewed,criticalReviewIds=sorted(set(critical)),semanticUncertain=semantic_uncertain)
    return result

def latency(data):
    rows=data['rows'];xs=[r['latency_ms']for r in rows]
    elapsed=(datetime.datetime.fromisoformat(data['updatedAt'].replace('Z','+00:00'))-datetime.datetime.fromisoformat(data['startedAt'].replace('Z','+00:00'))).total_seconds()
    return {'requests':len(rows),'p50Ms':quantile(xs,.5),'p95Ms':quantile(xs,.95),'wallSeconds':elapsed,'requestsPerSecond':len(rows)/elapsed,'observedOverActualFiveSecondDeadline':sum(x>5000 for x in xs),'errors':sum(bool(r.get('error'))for r in rows),'finishReasons':{reason:sum(c.get('finishReason')==reason for c in data.get('calls',[]))for reason in sorted(set(c.get('finishReason')for c in data.get('calls',[])if c.get('finishReason')is not None))}}

def resources(run,segments=None):
    p=private/(run+'-resources.jsonl');rows=list(map(json.loads,p.read_text().splitlines()))
    result={'samples':len(rows),'peakRssBytes':max(r['rssBytes']or 0 for r in rows),'medianRssBytes':statistics.median(r['rssBytes']for r in rows if r['rssBytes']is not None),'maxHealthWallMs':max(r['healthWallMs']for r in rows),'maxDaemonTrailingMinuteLagMs':max((r.get('daemonLagMs')or 0)for r in rows),'healthFailures':sum(r['healthStatus']!=200 for r in rows),'swapGrowthBytes':max(r['swapUsedBytes']for r in rows)-rows[0]['swapUsedBytes'],'minimumFreePlusInactiveBytes':min(r['freePlusInactiveBytes']for r in rows),'rawSha256':hashlib.sha256(p.read_bytes()).hexdigest()}
    if segments:
        def epoch(value):return datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
        result['segments']={}
        for name,data in segments.items():
            start,end=epoch(data['startedAt']),epoch(data['updatedAt']);xs=[r['rssBytes']for r in rows if start<=r['ts']<=end and r.get('rssBytes')is not None]
            result['segments'][name]={'samples':len(xs),'medianRssBytes':quantile(xs,.5),'peakRssBytes':max(xs)if xs else None}
        if 'serial'in segments and 'burst'in segments:
            start,end=epoch(segments['serial']['updatedAt']),epoch(segments['burst']['startedAt']);xs=[r['rssBytes']for r in rows if start<r['ts']<end and r.get('rssBytes')is not None]
            result['segments']['residentIdle']={'seconds':end-start,'samples':len(xs),'medianRssBytes':quantile(xs,.5)}
    for key in ['cpuPercent','systemGpuUtilizationPercent']:
        xs=[r[key]for r in rows if r.get(key)is not None];result[key]={'median':quantile(xs,.5),'max':max(xs)if xs else None}
    return result

report={'method':'First repetition primary; distinct cohorts; answered-only confusion/F1 plus all-definite accuracy and explicit errors. Quantiles use linear interpolation. Gate-eligible text is before search dispatch. Process-cold startup follows artifact hashing and is not disk-cold. No query-JSON probabilities invented. Semantic labels are exact-pair model-blind AI reviews, not human evidence.','models':[]}
for policy in ['r1','r2']:
    assert len(args.runs)==1
    run=args.runs[0]
    data=json.loads((private/run/policy/'serial/run.json').read_text());burst=json.loads((private/run/policy/'burst/run.json').read_text())
    assert data['complete']and burst['complete']and len(data['rows'])==192 and len(burst['rows'])==16
    first=[r for r in data['rows']if r['repetition']==1];second={r['case_id']:r for r in data['rows']if r['repetition']==2}
    assert len(first)==96 and len(second)==96
    item={'run':run,'policy':policy,'model':data['config']['models'][0],'cohorts':{s:metrics([r for r in first if fixtures[r['case_id']]['stratum']==s])for s in sorted(set(f['stratum']for f in fixtures.values()))},'serial':latency(data),'burst':latency(burst),'resources':resources(run,{'serial':data,'burst':burst}),'stableValidDecisions':sum(not r['error']and not second[r['case_id']]['error']and not r.get('contract_issues')and not second[r['case_id']].get('contract_issues')and r['verdict']==second[r['case_id']]['verdict']for r in first),'stabilityDenominator':96,'rawSha256':hashlib.sha256((private/run/policy/'serial/run.json').read_bytes()).hexdigest()}
    if reviews:
        all_rows=data['rows']+burst['rows'];safety=metrics(all_rows);item['allRowsSafety']={k:safety[k]for k in ['reviewedGateEligibleRows','criticalReviewIds','semanticUncertain','strictContractViolations','errors']}
    report['models'].append(item)
output=Path(args.out)
with output.open('x')as f:json.dump(report,f,indent=2,allow_nan=False);f.write('\n')
print(json.dumps({'models':[x['run']for x in report['models']],'semanticReviewsApplied':bool(reviews),'output':str(output)}))
