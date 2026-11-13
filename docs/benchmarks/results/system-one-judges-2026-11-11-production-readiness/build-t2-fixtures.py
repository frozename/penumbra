"""Freeze complete T2 inputs and blind AI labels; never publishes memory bodies."""
import hashlib
import json
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parent
PRIVATE = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261111/review-200')
REPO = ROOT.parents[3]


def rows(name):
    return [json.loads(line) for line in (PRIVATE / name).read_text().splitlines()]


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


key = {row['caseId']: row for row in rows('t2-private-key.jsonl')}
reviews = [row for name in ['t2-ai-review-a.jsonl', 't2-ai-review-b.jsonl', 't2-ai-adjudicated.jsonl'] for row in rows(name)]
embedded = {row['caseId'] for row in reviews if row.get('embeddedEvaluationClaims')}
fixtures = []
labels = rows('t2-ai-merged.jsonl')
for row in labels:
    original = key[row['caseId']]
    assert row['body'] == original['body']
    provenance = row['reviewProvenance']
    provenance['evidence'] = [item.replace(str(REPO) + '/', '') for item in provenance['evidence']]
    fixtures.append(dict(id='t2:' + row['caseId'], family='t2:' + sha(original['family']),
        split='test', workload='promotion', state={'kind': 'promote_t1', 'body': row['body']},
        labels={} if row['promote'] is None else {'promote': row['promote']}, labelRationale=row['rationale'],
        labeler='+'.join(provenance['reviewers']), labelStatus='independently-ai-reviewed', reviewProvenance=provenance,
        source={'kind': 'historical', 'table': 't2_memories', 'id': original['memory_id'], 'sha256': sha(row['body'])},
        tags=['complete-t2-body', 'independent-ai-reviewed', 'common-base-model-reviewers'] +
             (['embedded-historical-evaluation-claims'] if row['caseId'] in embedded else [])))
text = ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in fixtures)
path = PRIVATE / 't2-confirmatory-fixtures.jsonl'
if path.exists():
    assert path.read_text() == text, 'frozen fixture changed'
else:
    path.write_text(text)
    path.chmod(0o600)
manifest = json.loads((ROOT / 't2-confirmatory-manifest.json').read_text())
manifest.update(status='labels frozen before candidate inference',
    labelCounts=dict(Counter(str(row['promote']) for row in labels)),
    factualSupportCounts=dict(Counter(row['factualSupport'] for row in labels)),
    adjudications=39, embeddedHistoricalEvaluationClaims=len(embedded),
    reviewMethod='Two fresh blind AI source-check reviews, distinct AI adjudication of durability/factualSupport disputes; common model family, no human adjudication.',
    privateFixturePath=str(path), privateFixtureRawSha256=sha(text),
    provenanceHashes={name: hashlib.sha256((PRIVATE / name).read_bytes()).hexdigest() for name in
        ['t2-reviewer-a.jsonl','t2-ai-review-a.jsonl','t2-ai-review-b.jsonl','t2-ai-adjudicated.jsonl','t2-ai-merged.jsonl']},
    blindingCaveat='Current study predictions withheld. Some input bodies themselves contained older benchmark/model numbers; reviewers flagged those as unverified content. Report that slice separately.',
    negativeSampleLimit='Only14 independently AI-labeled negatives; cannot certify a2% false-promotion upper bound. Stratified source-family sample, not population prevalence.')
(ROOT / 't2-confirmatory-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({key:manifest[key] for key in ['labelCounts','factualSupportCounts','embeddedHistoricalEvaluationClaims','privateFixtureRawSha256']}))
