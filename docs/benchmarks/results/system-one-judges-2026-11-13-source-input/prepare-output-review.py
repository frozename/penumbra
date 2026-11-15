import hashlib
import json
import os
from pathlib import Path
import random

os.umask(0o077)
private = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-source-input')
out = private / 'output-review-packet.jsonl'
if out.exists():
    raise SystemExit('Fresh review packet required')
inputs = [json.loads(line) for line in (private / 'historical.jsonl').read_text().splitlines()]
labels = {row['caseId']: row for row in map(json.loads, (private / 'labels-adjudicated.jsonl').read_text().splitlines())}
profiles = ['granite-legacy', 'granite-source', 'z13-source']
omitted = []
if (private / 'macbook-source.json').exists():
    macbook = json.loads((private / 'macbook-source.json').read_text())
    if len(macbook.get('rows', [])) == 28:
        profiles.append('macbook-source')
    else:
        omitted.append({'profile': 'macbook-source', 'rows': len(macbook.get('rows', [])), 'reason': 'Memory-reserve guard aborted before first completed response. No quality result; raw initialized record and sensor/lifecycle evidence retained.'})
random.SystemRandom().shuffle(profiles)
key = {chr(65 + i): profile for i, profile in enumerate(profiles)}
runs = {}
for alias, profile in key.items():
    data = json.loads((private / (profile + '.json')).read_text())
    assert len(data['rows']) == 28 and len({row['id'] for row in data['rows']}) == 28
    rows = {row['id']: row for row in data['rows'] if row['id'].startswith('source-')}
    assert len(rows) == 24
    runs[alias] = rows
packets = []
for case in inputs:
    label = labels[case['id']]
    assert label['inputSha256'] == case['sha256']
    packet = {'caseId': case['id'], 'inputSha256': case['sha256'], 'transcript': case['transcript'], 'source': case['source'], 'label': label, 'runs': []}
    for alias, rows in runs.items():
        row = rows[case['id']]
        proposed = row.get('value', [])
        body_validation = row.get('bodyValidation', [])
        assert len(proposed) == len(body_validation)
        mechanical = [body_validation[i]['ok'] and memory.get('promote') is not False and memory.get('is_episodic') is not True and memory.get('obs_type') != 'standing_brief' and (len(memory['body'].strip()) >= 80 or (memory.get('depth') or 0) >= 2) for i, memory in enumerate(proposed)]
        packet['runs'].append({'anonymousRun': alias, 'memories': proposed, 'mechanicallyPromotable': mechanical, 'abstention': 'error' in row})
    packets.append(packet)
with out.open('x') as output:
    for packet in packets:
        output.write(json.dumps(packet) + '\n')
(private / 'output-review-key.json').write_text(json.dumps(key, indent=2) + '\n')
Path(__file__).resolve().with_name('review-coverage.json').write_text(json.dumps({'completedProfiles': profiles, 'omitted': omitted, 'caseRunRows': len(packets) * len(key)}, indent=2) + '\n')
print(json.dumps({'cases': len(packets), 'anonymousRuns': len(key), 'caseRunRows': len(packets) * len(key), 'proposals': sum(len(run['memories']) for case in packets for run in case['runs']), 'packetSha256': hashlib.sha256(out.read_bytes()).hexdigest()}))
