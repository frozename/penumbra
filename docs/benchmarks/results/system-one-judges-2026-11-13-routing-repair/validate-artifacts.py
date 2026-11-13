"""Read-only integrity/coverage checks for the completed paired repair study."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent
repo = root.parents[3]
private = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-routing-repair')
run = sys.argv[1]
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
freeze = json.loads((root/'candidate-freeze-v4.json').read_text())
manifest = json.loads((root/'test-manifest.json').read_text())
for name, digest in freeze['codeSha256'].items():
    assert sha(repo/name) == digest, name
for name, digest in freeze['baselineCodeSha256'].items():
    assert sha(private/'baseline-source'/name) == digest, name
assert subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD:packages'],text=True).strip() == freeze['candidatePackageTree']
assert sha(root/'test-manifest.json') == freeze['testManifestSha256']
assert sha(private/'fixtures.jsonl') == manifest['fixtureSha256']
assert sha(private/'labels-adjudicated.jsonl') == manifest['labelSha256']
fixtures = {x['id']:x for x in map(json.loads,(private/'fixtures.jsonl').read_text().splitlines())}
assert len(fixtures) == 96
for f in fixtures.values():
    canonical = json.dumps({k:f[k] for k in ['title','body_first_200']},ensure_ascii=False,separators=(',',':'))
    assert hashlib.sha256(canonical.encode()).hexdigest() == f['inputSha256']
calls = 0
raw = {}
for policy in ['r1','r2']:
    for phase in ['serial','burst']:
        path = private/run/policy/phase/'run.json'
        data = json.loads(path.read_text())
        assert data['complete'] and data['applied'] is False
        assert len(data['rows']) == (192 if phase=='serial' else 16)
        assert len(data['calls']) == len(data['rows'])
        assert data['config']['models'][0]['timeoutMs'] == 5000
        keys = [(x['case_id'],x['repetition']) for x in data['rows']]
        assert len(set(keys)) == len(keys)
        for x in data['rows']:
            assert x['expected_verdict'] == fixtures[x['case_id']]['expected_verdict']
            if policy=='r2' and (x['error'] or not x['production_gate_pass']):
                assert x['gate_eligible_text'] is None
        if phase=='serial':
            assert {x[0] for x in keys} == set(fixtures)
        calls += len(data['rows']);raw[policy+'/'+phase] = sha(path)
assert calls == 416
packet = list(map(json.loads,(private/'output-review-packet.jsonl').read_text().splitlines()))
reviews = list(map(json.loads,(private/'output-labels-adjudicated.jsonl').read_text().splitlines()))
assert len({r['reviewId'] for r in packet}) == len(packet)
assert len({r['reviewId'] for r in reviews}) == len(reviews)
assert {r['reviewId'] for r in packet} == {r['reviewId'] for r in reviews}
for row in packet:
    review = next(x for x in reviews if x['reviewId']==row['reviewId'])
    assert all(review[k] == row[k] for k in ['inputSha256','querySha256'])
    assert hashlib.sha256(row['query'].encode()).hexdigest() == row['querySha256']
    assert fixtures[row['caseId']]['inputSha256'] == row['inputSha256']
    assert all(review[k] in [True,False,'uncertain'] for k in ['faithful','publicTopic','usefulFormulation','safeQuery'])
    assert all(isinstance(review[k],bool) for k in ['privateLeak','injectionFollowed'])
proof = {'status':'passed','calls':calls,'uniqueReviewedQueryPairs':len(packet),'historicalTextPublished':False,'rawReplaySha256':raw,'finalOutputLabelsSha256':sha(private/'output-labels-adjudicated.jsonl'),'candidateFreezeSha256':sha(root/'candidate-freeze-v4.json'),'scope':'Integrity and complete exact-pair coverage, not quality acceptance or a deployment.'}
print(json.dumps(proof,indent=2))
