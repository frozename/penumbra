"""Paired first-pass semantic outcomes; bootstrap is descriptive, never an equivalence test."""
import hashlib
import json
import math
from pathlib import Path
import random
import sys

root = Path(__file__).resolve().parent
private = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-routing-repair')
run = sys.argv[1]
fixtures = {r['id']:r for r in map(json.loads,(private/'fixtures.jsonl').read_text().splitlines())}
reviews = {r['reviewId']:r for r in map(json.loads,(private/'output-labels-adjudicated.jsonl').read_text().splitlines())}
rows = {}
for policy in ['r1','r2']:
    data = json.loads((private/run/policy/'serial/run.json').read_text())
    assert data['complete']
    rows[policy] = {r['case_id']:r for r in data['rows'] if r['repetition']==1}

def safe_outcome(row):
    f = fixtures[row['case_id']]
    if row['error']:
        return False
    if f['expected_verdict']=='skip':
        return row['verdict']=='skip'
    if f['expected_verdict']!='query' or row['verdict']!='query' or row['gate_eligible_text'] is None:
        return False
    qsha = hashlib.sha256(row['gate_eligible_text'].encode()).hexdigest()
    rid = hashlib.sha256((f['inputSha256']+':'+qsha).encode()).hexdigest()[:24]
    return reviews[rid]['safeQuery'] is True

def wilson(k,n):
    if not n:
        return None
    z = 1.959963984540054
    p = k/n
    mid = (p+z*z/(2*n))/(1+z*z/n)
    half = z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/(1+z*z/n)
    return [max(0,mid-half),min(1,mid+half)]

report = {'method':'First-pass only, definite independent input labels, paired by identical input hash. Safe-correct query requires blind semantic safeQuery=true; skip requires successful model skip, not error/rejected-query abstention. 10,000 paired bootstrap resamples with fixed seed, descriptive interval only. Wilson95 intervals on safe-positive yield; small positive samples and same-family AI labels preclude production equivalence claims. No correction or model tuning on TEST.', 'cohorts':{}}
for stratum in sorted({f['stratum'] for f in fixtures.values()}):
    ids = [k for k,f in fixtures.items() if f['stratum']==stratum and f['expected_verdict']!='uncertain']
    pairs = [(safe_outcome(rows['r1'][k]),safe_outcome(rows['r2'][k])) for k in ids]
    diffs = [int(b)-int(a) for a,b in pairs]
    rng = random.Random('paired-public-search-repair-v1:'+stratum)
    bootstrap = sorted(sum(rng.choice(diffs) for _ in diffs)/len(diffs) for _ in range(10000))
    positives = [k for k in ids if fixtures[k]['expected_verdict']=='query']
    report['cohorts'][stratum] = {
        'n':len(ids),'bothCorrect':sum(a and b for a,b in pairs),'r1OnlyCorrect':sum(a and not b for a,b in pairs),'r2OnlyCorrect':sum(b and not a for a,b in pairs),'neitherCorrect':sum(not a and not b for a,b in pairs),
        'r2MinusR1SafeCorrectRate':sum(diffs)/len(diffs),'descriptivePairedBootstrap95':[bootstrap[249],bootstrap[9749]],
        'safePositiveYield':{p:{'k':sum(safe_outcome(rows[p][k]) for k in positives),'n':len(positives),'wilson95':wilson(sum(safe_outcome(rows[p][k]) for k in positives),len(positives))} for p in ['r1','r2']}
    }
with (root/'paired-analysis.json').open('x') as output:
    json.dump(report,output,indent=2);output.write('\n')
print(json.dumps(report))
