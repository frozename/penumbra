"""Publish hash-bound decisions and synthetic-only text; retain private historical text."""
import hashlib
import json
from pathlib import Path

root=Path(__file__).resolve().parent
private=Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-rewriter-validation')
fixtures={r['id']:r for r in map(json.loads,(private/'fixtures.jsonl').read_text().splitlines())}
reviews={r['reviewId']:r for r in map(json.loads,(private/'output-labels-adjudicated.final.jsonl').read_text().splitlines())}
public=[];controlled=[]
for run in ['rewriter-q8-indexed','rewriter-q4-indexed-v2']:
    for phase in ['serial','burst']:
        data=json.loads((private/run/phase/'run.json').read_text());assert data['complete']
        for row in data['rows']:
            f=fixtures[row['case_id']];review=None
            if row['gate_eligible_text']is not None:
                query_sha=hashlib.sha256(row['gate_eligible_text'].encode()).hexdigest();rid=hashlib.sha256((f['inputSha256']+':'+query_sha).encode()).hexdigest()[:24];review=reviews[rid]
            item={'run':run,'phase':phase,'repetition':row['repetition'],'caseId':f['id'],'inputSha256':f['inputSha256'],'stratum':f['stratum'],'expected':f['expected_verdict'],'verdict':row['verdict'],'latencyMs':row['latency_ms'],'error':row['error'],'strictContractIssues':row['contract_issues'],'gateEligible':row['gate_eligible_text']is not None,'reviewId':review['reviewId']if review else None,'safeQuery':review['safeQuery']if review else None,'privateLeak':review['privateLeak']if review else False,'injectionFollowed':review['injectionFollowed']if review else False}
            public.append(item)
            if f['stratum']=='controlled':controlled.append({**item,'raw':row['raw'],'queryOrReason':row['query_or_reason'],'gateEligibleText':row['gate_eligible_text']})
run='rewriter-nano-indexed-v2';data=json.loads((private/(run+'.json')).read_text());assert data['complete']
for row in data['rows']:
    f=fixtures[row['caseId']];public.append({'run':run,'phase':'serial','repetition':row['repetition'],'caseId':f['id'],'inputSha256':f['inputSha256'],'stratum':f['stratum'],'expected':f['expected_verdict'],'verdict':row.get('verdict'),'probabilityQuery':row.get('probabilityQuery'),'latencyMs':row['latencyMs'],'error':row.get('error'),'generationSemantics':'not_applicable'})
for name,rows in [('case-results.jsonl',public),('controlled-response-results.jsonl',controlled)]:
    with(root/name).open('x')as output:
        for row in rows:output.write(json.dumps(row,ensure_ascii=False)+'\n')
print(json.dumps({'decisionRows':len(public),'syntheticTextRows':len(controlled),'historicalTextPublished':False}))
