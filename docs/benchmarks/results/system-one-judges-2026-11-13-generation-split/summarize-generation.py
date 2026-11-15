import argparse
import datetime
import hashlib
import json
import math
from pathlib import Path
import statistics

parser = argparse.ArgumentParser()
parser.add_argument('--private', type=Path, default=Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-generation'))
args = parser.parse_args()
private = args.private
root = Path(__file__).resolve().parent

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def lines(name):
    return [json.loads(line) for line in (private / name).read_text().splitlines()]

def percentile(values, p):
    return sorted(values)[max(0, math.ceil(len(values) * p) - 1)]

labels = {r['caseId']: r for r in lines('labels-adjudicated.jsonl')}
assert len(labels) == 24
grades = lines('output-review-adjudicated.jsonl') + lines('small-output-review-agreed.jsonl')
assert len(grades) == 96
grade_map = {(r['caseId'], r['anonymousRun']): r for r in grades}
assert len(grade_map) == 96
runs = []
for model, filename, anonymous, context in [
    ('Granite Q8', 'granite', 'B', 16384),
    ('Kapitsa Qwen3.6 35B A3B 4bit', 'macbook', 'C', 131072),
    ('Gufo Qwen3.8 Flash-Next UD-Q4_K_XL', 'z13', 'A', 131072),
    ('Qwen3.5-2B Q4_K_M', 'qwen2b', 'D', 8192),
]:
    path = private / (filename + '-configured-final.json')
    data = json.loads(path.read_text())
    assert data['labelSha256'] == digest(private / 'labels-adjudicated.jsonl')
    rows = [r for r in data['rows'] if r['workload'] == 'historical-extraction']
    assert len(rows) == 24 and {r['id'] for r in rows} == set(labels)
    memories = []
    false_promotions = false_vetoes = negative_abstentions = 0
    covered = 0
    for row in rows:
        grade = grade_map[(row['id'], anonymous)]
        label = labels[row['id']]
        assert grade['inputSha256'] == label['inputSha256']
        assert grade['expectedFactCount'] == len(label['facts'])
        assert len(set(grade['coveredFactIndices'])) == len(grade['coveredFactIndices'])
        assert all(0 <= i < len(label['facts']) for i in grade['coveredFactIndices'])
        proposed = row.get('value', [])
        assert len(proposed) == len(grade['memories'])
        for m in grade['memories']:
            original = proposed[m['index']]
            promotable = original.get('promote') is not False and original.get('is_episodic') is not True and original.get('obs_type') != 'standing_brief' and (len(original['body'].strip()) >= 80 or (original.get('depth') or 0) >= 2)
            assert promotable == m['promotable']
            assert all(type(m[k]) is bool for k in ['supported', 'policyEligible', 'promotable'])
        memories.extend(grade['memories'])
        if label['verdict'] == 'positive':
            covered += len(grade['coveredFactIndices'])
            false_vetoes += not any(m['supported'] and m['policyEligible'] and m['promotable'] for m in grade['memories'])
        elif label['verdict'] == 'negative':
            false_promotions += any(m['promotable'] for m in grade['memories'])
            negative_abstentions += grade['abstention']
    times = [r['latencyMs'] for r in rows]
    controls = [r for r in data['rows'] if r['workload'] != 'historical-extraction']
    summary = {
        'name': model, 'target': filename, 'modelId': data['model'], 'contextTokens': context,
        'rawPrivatePath': str(path), 'rawSha256': digest(path), 'historicalCases': len(rows),
        'validHistoricalResponses': sum('value' in r for r in rows),
        'historicalErrors': [{'id': r['id'], 'class': 'schema-invalid'} for r in rows if 'error' in r],
        'proposalsAllCases': len(memories), 'mechanicallyPromotableAllCases': sum(m['promotable'] for m in memories),
        'sourceSupportedAllCases': sum(m['supported'] for m in memories),
        'policyEligibleAllCases': sum(m['policyEligible'] for m in memories),
        'supportedAndEligibleAllCases': sum(m['supported'] and m['policyEligible'] for m in memories),
        'coveredExpectedFactInstances': covered, 'expectedFactInstances': 5,
        'falsePromotionCasesOf19Negatives': false_promotions, 'negativeAbstentions': negative_abstentions,
        'positiveCasesWithoutSafeExtractionOf4': false_vetoes,
        'historicalLatencyMs': {'median': statistics.median(times), 'nearestRankP95': percentile(times, .95), 'min': min(times), 'max': max(times)},
        'controlsPassed': sum(r.get('controlPassed') is True for r in controls), 'controls': len(controls),
        'failedControls': [r['id'] for r in controls if not r.get('controlPassed')],
        'httpRequests': len(data['calls']), 'httpErrors': sum(c['status'] != 200 for c in data['calls']),
        'observedReasoningChars': sum(c.get('reasoningChars', 0) for c in data['calls']),
    }
    resource_file = private / (filename + '-resources.jsonl')
    if resource_file.exists():
        samples = [json.loads(line) for line in resource_file.read_text().splitlines()]
        start = datetime.datetime.fromisoformat(data['startedAt'].replace('Z', '+00:00')).timestamp()
        end = datetime.datetime.fromisoformat(data['updatedAt'].replace('Z', '+00:00')).timestamp()
        active = [r for r in samples if start <= r['ts'] <= end]
        assert active
        summary['resources'] = {
            'method': 'One-Hz single-model-process RSS, not physical footprint or total unified memory. GPU counters are host-wide; CPU ps is a decaying average. Interval filtered to configured-driver window.',
            'rawSha256': digest(resource_file), 'samples': len(active),
            'intervalSpanCoverage': (active[-1]['ts'] - active[0]['ts']) / (end - start),
            'sampledRssMedianBytes': statistics.median(r['rssBytes'] for r in active if r['rssBytes'] is not None),
            'sampledRssPeakBytes': max(r['rssBytes'] or 0 for r in active),
            'healthFailures': sum(r.get('healthStatus') != 200 for r in active),
            'healthWallMsNearestRankP95': percentile([r['healthWallMs'] for r in active], .95),
            'swapGrowthBytes': active[-1]['swapUsedBytes'] - active[0]['swapUsedBytes'],
            'swapins': active[-1]['swapins'] - active[0]['swapins'], 'swapouts': active[-1]['swapouts'] - active[0]['swapouts'],
            'sampledPsCpuPeakPercent': max(r['cpuPercent'] or 0 for r in active),
            'hostGpuInUsePeakBytes': max(r['systemGpuInUseBytes'] or 0 for r in active),
            'hostGpuAllocatedPeakBytes': max(r['systemGpuAllocatedBytes'] or 0 for r in active),
        }
    runs.append(summary)

provenance_files = ['historical.jsonl', 'review-a.jsonl', 'review-b.jsonl', 'labels-adjudicated.jsonl', 'output-review-packet.jsonl', 'output-review-a.jsonl', 'output-review-b.jsonl', 'output-review-a-normalized.jsonl', 'output-review-b-normalized.jsonl', 'output-review-adjudicated.jsonl', 'small-output-review-packet.jsonl', 'small-output-review-a.jsonl', 'small-output-review-b.jsonl', 'small-output-review-agreed.jsonl']
report = {
    'method': 'Current summary-first T2 input contract;24 historical transcripts, frozen independent AI labels before inference. Four positives,19 negatives,1 uncertain;5 expected fact instances (aggregation lesson repeated across two cases).2 independent model-blind output grades plus adjudication for A/B/C;2 agreeing independent grades for D. Common base-model family, not human or population-random evidence.',
    'qualityRules': 'Uncertain case20 excluded from known-truth case rates. Fact coverage can credit a correct core while unsupported additions make the full proposal unsafe. False-promotion cases count mechanically promotable proposals on labeled negative inputs, before later dedupe/storage effects. Safe extraction requires source-supported AND policy-eligible AND mechanically promotable; no model supplied one on a known positive.',
    'blindingCaveat': 'Output reviewer B saw reviewer A completion summary only after B source grades were written and hashed. Source grades stayed frozen. Parent normalized only abstention from packet error markers so valid empty arrays are not abstentions. Disputes were then adjudicated without model identities.',
    'provenanceSha256': {name: digest(private / name) for name in provenance_files},
    'runs': runs, 'controlledHttpRequests': sum(r['httpRequests'] for r in runs),
    'productionAuthorityChanged': False,
}
(root / 'configured-generation-summary.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(runs, indent=2))
