"""Seal fresh independently adjudicated inputs; never print private case text."""
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import subprocess

os.umask(0o077)
root = Path(__file__).resolve().parent
private = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-routing-repair')
expected = {
    'review-packet.jsonl': 'df571b5f49cb43b00bd90327cc17800a60ccf395d6cd2382c964f538ae7ad67d',
    'review-a.jsonl': '105430596ad62e1fcadcf861fe4f7f1961761a855dc46607b0f4dd06f3177933',
    'review-b.jsonl': '9309fe0f8b2e5aad3474390f9cc7f5fac41aa34489a5423fbd0b3c5ea8e95a67',
    'labels-adjudicated.jsonl': '22887f52131a8f3874c73d4b2166076c24266c5268e9a5ff0baad6eeb7e5a54b',
    'curator-manifest.json': 'fa560bd78a612062d86dd46ddd0ef1983d6c3cd5bf358d5223029931ba0489fd',
    'label-adjudication.json': '465e8196e5d55498dc658d5e3eaffa876130130734aff0137c1956983fe19cbc',
}
sha = lambda value: hashlib.sha256(value).hexdigest()
for name, digest in expected.items():
    assert sha((private/name).read_bytes()) == digest, name
rows = [json.loads(line) for line in (private/'review-packet.jsonl').read_text().splitlines()]
labels = {x['caseId']: x for x in map(json.loads, (private/'labels-adjudicated.jsonl').read_text().splitlines())}
fixtures = []
for row in rows:
    label = labels[row['id']]
    assert label['inputSha256'] == row['inputSha256']
    fixtures.append({**{key: row[key] for key in ['id','title','body_first_200','inputSha256','stratum']}, 'expected_verdict': label['verdict']})
assert len(fixtures) == len(labels) == 96
text = ''.join(json.dumps(x, ensure_ascii=False, separators=(',',':'))+'\n' for x in fixtures)
with (private/'fixtures.jsonl').open('x') as output:
    output.write(text)
subprocess.run(['chflags','uchg',str(private/'fixtures.jsonl')],check=True)
controlled = ''.join(json.dumps(x, ensure_ascii=False, separators=(',',':'))+'\n' for x in fixtures if x['stratum']=='controlled')
with (root/'controlled-fixtures.jsonl').open('x') as output:
    output.write(controlled)
manifest = {
    'cases': len(fixtures), 'fixtureSha256': sha(text.encode()), 'labelSha256': expected['labels-adjudicated.jsonl'],
    'inputArtifactSha256': expected, 'strata': dict(Counter(x['stratum'] for x in fixtures)),
    'labelsByStratum': {s: dict(Counter(x['expected_verdict'] for x in fixtures if x['stratum']==s)) for s in sorted({x['stratum'] for x in fixtures})},
    'casesManifest': [{k:x[k] for k in ['id','inputSha256','stratum','expected_verdict']} for x in fixtures],
    'controlledFixtureSha256': sha(controlled.encode()),
    'method': 'Fresh 64 deterministic historical samples, 16 enriched public cases and 16 controlled cases. Two independent AI input reviewers plus source-checking AI adjudication; same model family, no human ground truth. Private real inputs withheld. Prior 111-case corpus is development only. No TEST output inspected before sealing.'
}
with (root/'test-manifest.json').open('x') as output:
    json.dump(manifest,output,indent=2);output.write('\n')
print(json.dumps({k:v for k,v in manifest.items() if k!='casesManifest'}))
