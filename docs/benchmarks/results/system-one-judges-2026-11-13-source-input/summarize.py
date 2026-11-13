import datetime
import hashlib
import json
import math
from pathlib import Path
import statistics

root = Path(__file__).resolve().parent
private = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-source-input')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rows(name):
    return [json.loads(line) for line in (private / name).read_text().splitlines()]


def p95(values):
    return sorted(values)[math.ceil(len(values) * .95) - 1]


def times(values):
    return {'median': statistics.median(values), 'nearestRankP95': p95(values), 'min': min(values), 'max': max(values)}


labels = {row['caseId']: row for row in rows('labels-adjudicated.jsonl')}
assert len(labels) == 24
positives = sum(row['verdict'] == 'positive' for row in labels.values())
negatives = sum(row['verdict'] == 'negative' for row in labels.values())
expected_facts = sum(len(row['facts']) for row in labels.values())
key = json.loads((private / 'output-review-key.json').read_text())
grades = rows('output-review-adjudicated.jsonl')
grade_map = {(row['caseId'], row['anonymousRun']): row for row in grades}
assert len(grade_map) == len(grades) == 24 * len(key)
runs = []
for alias, profile in key.items():
    path = private / (profile + '.json')
    data = json.loads(path.read_text())
    assert data['labelSha256'] == digest(private / 'labels-adjudicated.jsonl')
    historical = [row for row in data['rows'] if row['id'].startswith('source-')]
    assert len(historical) == 24 and len({row['id'] for row in historical}) == 24
    controls = [row for row in data['rows'] if row['id'].startswith('control-')]
    all_memories = []
    false_promotion = positive_without_safe = negative_abstentions = coverage = safe_coverage = 0
    for row in historical:
        label = labels[row['id']]
        grade = grade_map[(row['id'], alias)]
        assert grade['inputSha256'] == label['inputSha256']
        assert grade['abstention'] == ('error' in row)
        assert grade['expectedFactCount'] == len(label['facts'])
        memories = row.get('value', [])
        assert len(grade['memories']) == len(memories)
        covered, safe_covered = set(), set()
        for index, memory in enumerate(memories):
            m = grade['memories'][index]
            assert m['index'] == index
            promotable = row['bodyValidation'][index]['ok'] and memory.get('promote') is not False and memory.get('is_episodic') is not True and memory.get('obs_type') != 'standing_brief' and (len(memory['body'].strip()) >= 80 or (memory.get('depth') or 0) >= 2)
            assert m['promotable'] == promotable
            assert all(type(m[k]) is bool for k in ['promotable', 'supported', 'policyEligible'])
            assert len(m['coveredFactIndices']) == len(set(m['coveredFactIndices']))
            assert all(0 <= fact < len(label['facts']) for fact in m['coveredFactIndices'])
            covered.update(m['coveredFactIndices'])
            if m['supported'] and m['policyEligible'] and m['promotable']:
                safe_covered.update(m['coveredFactIndices'])
        assert set(grade['coveredFactIndices']) == covered
        all_memories.extend(grade['memories'])
        coverage += len(covered)
        safe_coverage += len(safe_covered)
        safe = any(m['supported'] and m['policyEligible'] and m['promotable'] for m in grade['memories'])
        if label['verdict'] == 'positive':
            positive_without_safe += not safe
        elif label['verdict'] == 'negative':
            false_promotion += any(m['promotable'] for m in grade['memories'])
            negative_abstentions += grade['abstention']
    call_status = {}
    for call in data['calls']:
        status = str(call.get('status', 'transport-error'))
        call_status[status] = call_status.get(status, 0) + 1
    proposed = len(all_memories)
    promotable = sum(m['promotable'] for m in all_memories)
    safe = sum(m['supported'] and m['policyEligible'] and m['promotable'] for m in all_memories)
    result = {
        'profile': profile, 'modelId': data['model'], 'sourceMode': data['sourceMode'],
        'rawSha256': digest(path), 'historicalCases': 24,
        'validHistoricalArrays': sum('value' in row for row in historical),
        'historicalAbstentions': [{'caseId': row['id'], 'error': row['error']} for row in historical if 'error' in row],
        'acceptedProposals': proposed, 'mechanicallyPromotable': promotable,
        'fullySupported': sum(m['supported'] for m in all_memories),
        'policyEligible': sum(m['policyEligible'] for m in all_memories),
        'supportedAndEligible': sum(m['supported'] and m['policyEligible'] for m in all_memories),
        'safePromotableProposals': safe, 'safeProposalPrecision': safe / promotable if promotable else None,
        'factInstancesCovered': coverage, 'safeFactInstancesCovered': safe_coverage, 'expectedFactInstances': expected_facts,
        'safeFactRecall': safe_coverage / expected_facts if expected_facts else None,
        'negativeCasesWithPromotableProposals': false_promotion, 'negativeCases': negatives,
        'negativeAbstentions': negative_abstentions,
        'positiveCasesWithoutSafeExtraction': positive_without_safe, 'positiveCases': positives,
        'historicalLatencyMs': times([row['latencyMs'] for row in historical]),
        'historicalCasesPerSecond': 24 / (sum(row['latencyMs'] for row in historical) / 1000),
        'controlsPassed': sum(row.get('controlPassed') is True for row in controls), 'controls': len(controls),
        'failedControls': [row['id'] for row in controls if row.get('controlPassed') is not True],
        'httpCalls': len(data['calls']), 'httpStatusCounts': call_status,
        'tokenTruncatedReplies': sum(call.get('finishReason') == 'length' for call in data['calls']),
        'reasoningChars': sum(call.get('reasoningChars', 0) for call in data['calls']),
        'runtimeConfiguration': data['configuration'],
    }
    samples_path = private / (profile + '-resources.jsonl')
    samples = rows(profile + '-resources.jsonl')
    start = datetime.datetime.fromisoformat(data['startedAt'].replace('Z', '+00:00')).timestamp()
    end = datetime.datetime.fromisoformat(data['updatedAt'].replace('Z', '+00:00')).timestamp()
    active = [row for row in samples if start <= row.get('ts', row.get('measuredAt')) <= end]
    assert active
    resource = {'rawSha256': digest(samples_path), 'samples': len(active), 'intervalSpanCoverage': (active[-1].get('ts', active[-1].get('measuredAt')) - active[0].get('ts', active[0].get('measuredAt'))) / (end - start)}
    if profile.startswith('granite'):
        resource.update(method='One-Hz single-model-process RSS after warmup, not physical footprint or total unified memory. Host GPU counters are separate and not additive.',
                        rssMedianBytes=statistics.median(row['rssBytes'] for row in active), rssPeakBytes=max(row['rssBytes'] for row in active),
                        minFreePlusInactiveBytes=min(row['freePlusInactiveBytes'] for row in active),
                        swapGrowthBytes=active[-1]['swapUsedBytes']-active[0]['swapUsedBytes'],
                        swapins=active[-1]['swapins']-active[0]['swapins'], swapouts=active[-1]['swapouts']-active[0]['swapouts'],
                        healthFailures=sum(row['healthStatus'] != 200 for row in active), healthP95Ms=p95([row['healthWallMs'] for row in active]),
                        sampledPsCpuPeakPercent=max(row['cpuPercent'] for row in active),
                        hostGpuInUsePeakBytes=max(row['systemGpuInUseBytes'] or 0 for row in active),
                        hostGpuAllocatedPeakBytes=max(row['systemGpuAllocatedBytes'] or 0 for row in active))
    else:
        cpu = [100 * (b['gufo']['cpuTicks'] - a['gufo']['cpuTicks']) / b['cpuClockTicksPerSecond'] / (b['measuredAt'] - a['measuredAt']) for a, b in zip(active, active[1:])]
        gpu = [float(value) for row in active for value in row['gpuBusyPercent'].values() if value is not None and str(value).isdigit()]
        temperatures = [row['maxTemperatureC'] for row in active if row['maxTemperatureC'] is not None]
        resource.update(method='One-Hz existing Linux sensor, Gufo process RSS includes already-resident model. Not incremental memory or cgroup/NPU footprint. CPU uses process tick deltas; GPU/thermal counters are host-wide.',
                        rssMedianBytes=statistics.median(row['gufo']['rssBytes'] for row in active), rssPeakBytes=max(row['gufo']['rssBytes'] for row in active),
                        minAvailableBytes=min(row['availableBytes'] for row in active), swapGrowthBytes=max(row['swapGrowthBytes'] for row in active),
                        swapoutBytes=max(row['swapoutBytes'] for row in active), maxMemoryFullAvg10=max(row['memoryFullAvg10'] for row in active),
                        healthFailureSamples=sum(row['gufoHealthFailures'] > 0 for row in active), healthP95Ms=p95([row['gufoHealthMs'] for row in active]),
                        maxProcessingSlots=max(row['processingSlots'] for row in active), cpuIntervalPeakPercent=max(cpu) if cpu else None,
                        readableGpuBusyPeakPercent=max(gpu) if gpu else None, maxReadableThermalZoneC=max(temperatures) if temperatures else None)
    result['resources'] = resource
    runs.append(result)
report = {'method': 'Frozen historical inputs, independent common-family AI source labels before inference and model-blind output grades. No Granite ground truth. Joint evidence/prompt change, not input-only ablation.',
          'qualityUnits': 'Proposal precision and expected-fact recall have different units and are not combined into an F1. No probability calibration for generated arrays. Binary judge F1/Brier/ECE remain in the separate classifier study.',
          'labelCounts': {'positive': positives, 'negative': negatives, 'expectedFactInstances': expected_facts},
          'smallSampleLimit': 'One positive case and23 negatives cannot establish production recall or low population false-promotion bounds. Purposeful sampling and AI-review correlation further limit inference.',
          'provenanceSha256': {name: digest(private / name) for name in ['historical.jsonl', 'labels-adjudicated.jsonl', 'output-review-packet.jsonl', 'output-review-key.json', 'output-review-a.jsonl', 'output-review-b.jsonl', 'output-review-adjudicated.jsonl']},
          'runs': sorted(runs, key=lambda row: row['profile']), 'macbook': json.loads((root / 'macbook-guard-outcome.json').read_text()),
          'productionAuthorityChanged': False, 'sourceFlagActivated': False}
(root / 'source-extraction-summary.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report['runs'], indent=2))
