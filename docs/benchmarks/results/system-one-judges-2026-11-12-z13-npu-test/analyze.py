"""Summarize existing benchmark outputs and Linux samples; never performs inference."""

import json
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]


def load(path):
    return json.loads(path.read_text()) if path.exists() else None


def cpu_stat(row):
    return dict(line.split() for line in (row['cgroup'].get('cpu.stat') or '').splitlines())


def resource_summary(rows):
    if not rows:
        return None
    rss = [r['runtime']['rssBytes'] for r in rows if r['runtime'].get('rssBytes') is not None]
    span = rows[-1]['measuredAt'] - rows[0]['measuredAt']
    first_cpu, last_cpu = cpu_stat(rows[0]), cpu_stat(rows[-1])
    return dict(
        samples=len(rows), sampledSpanSeconds=span,
        runtimeRssMedianBytes=median(rss) if rss else None,
        runtimeRssPeakBytes=max(rss) if rss else None,
        sampledCgroupPeakBytes=max(int(r['cgroup']['memory.peak']) for r in rows),
        availableMinBytes=min(r['availableBytes'] for r in rows),
        swapGrowthBytes=max(r['swapGrowthBytes'] for r in rows),
        swapoutBytes=max(r['swapoutBytes'] for r in rows),
        memoryFullAvg10Max=max(r['memoryFullAvg10'] for r in rows),
        gufoHealthFailureSamples=sum(r['gufoHealthFailures'] > 0 for r in rows),
        maxReadableThermalZoneC=max(r['maxTemperatureC'] or 0 for r in rows),
        cgroupAverageCpuCores=(int(last_cpu.get('usage_usec', 0))-int(first_cpu.get('usage_usec', 0)))/1e6/span if span else None,
        cgroupThrottledUsecDelta=int(last_cpu.get('throttled_usec', 0))-int(first_cpu.get('throttled_usec', 0)),
        gpuBusyMaxPercent=max((int(v) for r in rows for v in r['gpuBusyPercent'].values() if v and v.isdigit()), default=None),
        npuUtilizationPercent=None,
        caveat='One-Hz samples include startup/cleanup; accounting includes guardian/page cache and may omit driver/shared allocations. Do not equate cgroup or RSS with total physical NPU footprint or Mac unified memory.',
    )


def probe_summary(path):
    data = load(path)
    if not data:
        return None
    rows = data['rows']
    ttft = [r['ttftMs'] for r in rows if r['ttftMs'] is not None]
    elapsed = [r['elapsedMs'] for r in rows if r['error'] is None]
    return dict(samples=len(rows), errors=sum(r['error'] is not None for r in rows),
                medianTtftMs=median(ttft) if ttft else None,
                medianElapsedMs=median(elapsed) if elapsed else None,
                tokenUsageReported=sum(r['completionTokens'] is not None for r in rows))


def main():
    runs = []
    for path in sorted((ROOT/'runs').iterdir()):
        status = load(path/'trial-status.json')
        if not status:
            continue
        summary = load(path/'summary.json')
        samples = path/'resources.jsonl'
        rows = [json.loads(line) for line in samples.read_text().splitlines() if line] if samples.exists() else []
        item = dict(path=str(path.relative_to(REPO)), status=status,
                    resources=resource_summary(rows),
                    gufo={phase: probe_summary(path/('gufo-'+phase+'.json')) for phase in ['before', 'during', 'after']})
        if summary:
            item['performance'] = {k: summary[k] for k in ['requests', 'answered', 'failures', 'firstRequestMs', 'p50LatencyMs', 'p95LatencyMs', 'requestsPerSecond', 'fixtureSha256']}
            item['quality'] = {split: values.get('promote') for split, values in summary['quality'].items()}
            item['calibrationOnlyThresholdFit'] = summary['directThresholdFit']
        runs.append(item)
    baselines = []
    for name, relative in [
        ('Granite M4 excerpt', 'docs/benchmarks/results/system-one-judges-2026-11-11-production-readiness/granite-reviewed'),
        ('Nano Q8 M4 excerpt', 'docs/benchmarks/results/system-one-judges-2026-11-12-resume/nano-bounded'),
        ('Granite M4 complete body', 'docs/benchmarks/results/system-one-judges-2026-11-11-production-readiness/t2-granite'),
        ('Nano Q8 M4 complete body', 'docs/benchmarks/results/system-one-judges-2026-11-11-production-readiness/t2-nano'),
    ]:
        summary = load(REPO/relative/'summary.json')
        baselines.append(dict(name=name, path=relative,
                              quality=summary['quality']['test']['promote'],
                              fixtureSha256=summary['fixtureSha256'],
                              p50LatencyMs=summary['p50LatencyMs'], p95LatencyMs=summary['p95LatencyMs']))
    result = dict(runs=runs, historicalBaselines=baselines,
                  authorityChanged=False, admissionFloorIgnoredForTrial=True,
                  qualityAcceptance=False,
                  caveats=['Repeated development/confirmation corpora; no new labels or hidden acceptance set.',
                           'Different hardware, quantization, CPU caps, network and times. Baseline quality paired by frozen inputs; performance is not a simultaneous hardware comparison.',
                           'Gufo probes are three short samples/phase with cache/order effects, not a sustained production SLA.',
                           'Initial reviewed-named120-case run used the public subset; it is not the320-case corpus. Both original errors and corrected runs remain.',
                           'No power/energy or NPU utilization percentage measurement.'])
    (ROOT/'execution-summary.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'runs':len(runs),'out':str(ROOT/'execution-summary.json')}))


if __name__ == '__main__':
    main()
