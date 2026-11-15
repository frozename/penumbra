"""Build a model-blind unique query packet only from complete frozen replays."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys

parser=argparse.ArgumentParser()
parser.add_argument('--allow-incomplete',action='store_true')
parser.add_argument('--prefix',default='output-review')
parser.add_argument('--runs',nargs='+',required=True)
args=parser.parse_args()
if any(not re.fullmatch(r'[a-z0-9-]{1,48}',x)for x in args.runs+[args.prefix]):raise SystemExit('Simple run/prefix labels required')
os.umask(0o077)
private=Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-routing-repair')
root=Path(__file__).resolve().parent
fixtures={x['id']:x for x in map(json.loads,(private/'fixtures.jsonl').read_text().splitlines())}
labels={x['caseId']:x for x in map(json.loads,(private/'labels-adjudicated.jsonl').read_text().splitlines())}
units={};mapping=[]
for run in args.runs:
    for phase in ['r1/serial','r1/burst','r2/serial','r2/burst']:
        source=private/run/phase/'run.json'
        if args.allow_incomplete and not source.exists():continue
        data=json.loads(source.read_text())
        if not data['complete']and not args.allow_incomplete:raise RuntimeError('Incomplete source replay: '+run+'/'+phase)
        for row in data['rows']:
            text=row['gate_eligible_text']
            if text is None:continue
            c=fixtures[row['case_id']];label=labels[c['id']]
            assert label['inputSha256']==c['inputSha256']
            query_sha=hashlib.sha256(text.encode()).hexdigest()
            review_id=hashlib.sha256((c['inputSha256']+':'+query_sha).encode()).hexdigest()[:24]
            units[review_id]={'reviewId':review_id,'caseId':c['id'],'inputSha256':c['inputSha256'],'querySha256':query_sha,'title':c['title'],'body_first_200':c['body_first_200'],'query':text,'inputLabel':label}
            mapping.append({'reviewId':review_id,'run':run,'phase':phase,'modelId':row['model_id'],'caseId':c['id'],'repetition':row['repetition'],'modelVerdict':row['verdict'],'error':row['error'],'strictContractIssues':row['contract_issues'],'modelQueryPassesGate':row['production_gate_pass']})
packet=''.join(json.dumps(units[k],ensure_ascii=False)+'\n'for k in sorted(units))
with(private/(args.prefix+'-packet.jsonl')).open('x')as f:f.write(packet)
with(private/(args.prefix+'-mapping.json')).open('x')as f:json.dump(mapping,f,indent=2);f.write('\n')
proof={'runs':args.runs,'incompleteSourcesAllowed':args.allow_incomplete,'uniqueReviewUnits':len(units),'mappedRows':len(mapping),'packetSha256':hashlib.sha256(packet.encode()).hexdigest(),'mappingSha256':hashlib.sha256((private/(args.prefix+'-mapping.json')).read_bytes()).hexdigest(),'method':'Exact input and gate-eligible text deduplication. No model identity or operational data in reviewer packet. Semantic labels attach only to exact input/query pairs. Incomplete source packets support preliminary blind review only, never a completed model score. First repetition primary, repeats not independent quality samples.'}
with(root/(args.prefix+'-manifest.json')).open('x')as f:json.dump(proof,f,indent=2);f.write('\n')
print(json.dumps(proof))
