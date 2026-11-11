#!/usr/bin/env python3
"""Summarize host samples strictly inside one recorded benchmark interval."""
import argparse
import datetime
import json
import math
import statistics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    parser.add_argument("--samples", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    with open(args.run, encoding="utf-8") as source:
        run = json.load(source)
    start = datetime.datetime.fromisoformat(run["startedAt"].replace("Z", "+00:00")).timestamp()
    end = start + run["elapsedMs"] / 1000
    with open(args.samples, encoding="utf-8") as source:
        samples = [json.loads(line) for line in source if line.strip()]
    samples = [row for row in samples if start <= row["ts"] <= end]
    if not samples:
        raise SystemExit("No samples inside the recorded run interval")
    health = sorted(row["healthWallMs"] for row in samples)
    rss = [row["rssBytes"] for row in samples if row.get("rssBytes") is not None]
    cpu = [row["cpuPercent"] for row in samples if row.get("cpuPercent") is not None]
    output = {
        "run": args.run, "samples": len(samples), "intervalStart": start, "intervalEnd": end,
        "peakSampledRssBytes": max(rss), "medianSampledRssBytes": statistics.median(rss),
        "psCpuPercentMedian": statistics.median(cpu), "psCpuPercentPeak": max(cpu),
        "swapStartBytes": samples[0]["swapUsedBytes"], "swapEndBytes": samples[-1]["swapUsedBytes"],
        "swapGrowthBytes": max(row["swapUsedBytes"] for row in samples) - samples[0]["swapUsedBytes"],
        "swapinsDelta": samples[-1]["swapins"] - samples[0]["swapins"],
        "swapoutsDelta": samples[-1]["swapouts"] - samples[0]["swapouts"],
        "healthTimeoutOrFailureCount": sum(row["healthStatus"] != 200 for row in samples),
        "healthWallP50Ms": statistics.median(health), "healthWallP95Ms": health[math.ceil(len(health) * .95) - 1],
        "maxReportedDaemonLagMs": max(row.get("daemonLagMs") or 0 for row in samples),
        "systemGpuInUseBytesPeak": max(row.get("systemGpuInUseBytes") or 0 for row in samples),
        "systemGpuAllocatedBytesPeak": max(row.get("systemGpuAllocatedBytes") or 0 for row in samples),
        "systemGpuUtilizationPercentMedian": statistics.median(row.get("systemGpuUtilizationPercent") or 0 for row in samples),
        "limitations": "1 Hz sampled RSS is not total unified-memory ownership; GPU counters are system-wide. ps CPU is a decaying process metric. /health lagMs is a rolling maximum, not request latency. Other host activity is uncontrolled.",
    }
    with open(args.out, "w", encoding="utf-8") as target:
        json.dump(output, target, indent=2)
        target.write("\n")


if __name__ == "__main__":
    main()
