"""Independent integrity/count checks for published, privacy-preserving results."""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import subprocess

parser=argparse.ArgumentParser()
parser.add_argument("--out")
args=parser.parse_args()
root=Path(__file__).resolve().parent
repo=root.parents[3]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
parsed=0
for path in root.iterdir():
    if path.suffix=='.json':json.loads(path.read_text());parsed+=1
    elif path.suffix=='.jsonl':
        for line in path.read_text().splitlines():json.loads(line)
        parsed+=1
freeze=json.loads((root/'candidate-freeze.json').read_text())
for path,digest in freeze['codeSha256'].items():assert sha((root/path).resolve())==digest,path
nano=json.loads((root/'nano-protocol.json').read_text())
assert sha(root/'eval-nano.ts')==nano['driverSha256']
assert sha(root/'run-nano.py')==nano['runnerSha256']
ci=json.loads((root/'package-ci-validation.final.json').read_text());assert ci['ciExitCode']==0 and ci['status']=='passed'
assert subprocess.check_output(['git','rev-parse','HEAD:packages'],cwd=repo,text=True).strip()==ci['packageTree']
subprocess.run(['git','diff','--exit-code',ci['sourceCommit'],'--','packages','scripts','plugin'],cwd=repo,check=True,capture_output=True)
rows=list(map(json.loads,(root/'case-results.jsonl').read_text().splitlines()));assert len(rows)==698
assert len({(r['run'],r['phase'],r['repetition'],r['caseId'])for r in rows})==698
for row in rows:
    assert row['error']is None
    assert not any(k in row for k in ['title','body','body_first_200','raw','query','queryOrReason','gateEligibleText'])
report=json.loads((root/'final-results.json').read_text())
models=report['models']+[report['nativeClassificationOnly']]
for model in models:
    first=[r for r in rows if r['run']==model['run']and r['phase']=='serial'and r['repetition']==1]
    assert len(first)==111 and len({r['caseId']for r in first})==111
    for stratum,metrics in model['cohorts'].items():
        group=[r for r in first if r['stratum']==stratum];definite=[r for r in group if r['expected']!='uncertain']
        counts=collections.Counter(('tp'if r['expected']=='query'else'fp')if r['verdict']=='query'else('fn'if r['expected']=='query'else'tn')for r in definite)
        assert metrics['n']==len(group)and metrics['definiteLabels']==len(definite)
        for key in ['tp','fp','fn','tn']:assert metrics[key]==counts[key],(model['run'],stratum,key)
        if 'strictSafeCorrect'in metrics:
            safe=[r for r in definite if(r['verdict']=='skip'and r['expected']=='skip')or(r['verdict']=='query'and r['expected']=='query'and r['safeQuery']is True)]
            assert len(safe)==metrics['semanticSafeCorrect']
            assert sum(not r['strictContractIssues']for r in safe)==metrics['strictSafeCorrect']
        if 'brier'in metrics:
            assert all(isinstance(r['probabilityQuery'],(int,float))and math.isfinite(r['probabilityQuery'])and 0<=r['probabilityQuery']<=1 for r in definite)
            brier=sum((r['probabilityQuery']-int(r['expected']=='query'))**2 for r in definite)/len(definite)
            assert abs(brier-metrics['brier'])<1e-12
controlled=list(map(json.loads,(root/'controlled-response-results.jsonl').read_text().splitlines()))
assert len(controlled)==68 and all(r['stratum']=='controlled'for r in controlled)
proof={'status':'passed','parsedJsonOrJsonlFiles':parsed,'publishedDecisionRows':len(rows),'syntheticTextRows':len(controlled),'frozenCandidateHashesVerified':len(freeze['codeSha256'])+2,'fullCiSourceAndPackageTreeVerified':True,'confusionAndSemanticCountsIndependentlyRecomputed':True,'nativeBrierIndependentlyRecomputed':True,'historicalTextPublished':False,'scope':'Artifact integrity/count validation, separate from source tests and independent human/AI judgment.'}
if args.out:
    with Path(args.out).open('x')as f:json.dump(proof,f,indent=2);f.write('\n')
print(json.dumps(proof))
