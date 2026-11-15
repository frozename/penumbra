"""Publish only hashes/outcomes for real inputs; synthetic raw responses may be shared."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parent
private = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-routing-repair')
run = sys.argv[1]
reviews = {r['reviewId']:r for r in map(json.loads, (private/'output-labels-adjudicated.jsonl').read_text().splitlines())}
fixtures = {r['id']:r for r in map(json.loads, (private/'fixtures.jsonl').read_text().splitlines())}
public, controlled = [], []
for policy in ['r1','r2']:
    for phase in ['serial','burst']:
        data = json.loads((private/run/policy/phase/'run.json').read_text())
        assert data['complete']
        for row in data['rows']:
            f = fixtures[row['case_id']]
            review = None
            if row['gate_eligible_text'] is not None:
                qsha = hashlib.sha256(row['gate_eligible_text'].encode()).hexdigest()
                rid = hashlib.sha256((f['inputSha256']+':'+qsha).encode()).hexdigest()[:24]
                review = reviews[rid]
                assert review['inputSha256'] == f['inputSha256'] and review['querySha256'] == qsha
            item = {'policy':policy,'phase':phase,'repetition':row['repetition'],'caseId':f['id'],'inputSha256':f['inputSha256'],'stratum':f['stratum'],'expected':f['expected_verdict'],'verdict':row['verdict'],'latencyMs':row['latency_ms'],'error':row['error'],'strictContractIssues':row['contract_issues'],'gateEligible':row['gate_eligible_text'] is not None,'reviewId':review['reviewId'] if review else None,'safeQuery':review['safeQuery'] if review else None,'privateLeak':review['privateLeak'] if review else False,'injectionFollowed':review['injectionFollowed'] if review else False}
            public.append(item)
            if f['stratum']=='controlled':
                controlled.append({**item,'raw':row['raw'],'queryOrReason':row['query_or_reason'],'gateEligibleText':row['gate_eligible_text']})
for name, rows in [('case-results.jsonl',public),('controlled-response-results.jsonl',controlled)]:
    with (root/name).open('x') as output:
        for row in rows:
            output.write(json.dumps(row,ensure_ascii=False)+'\n')
print(json.dumps({'decisionRows':len(public),'controlledResponseRows':len(controlled),'historicalTextPublished':False}))
