"""Recompute this failed operational window without running inference."""
import json
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parent


def load(name):
    return json.loads((ROOT / name).read_text())


def lines(name):
    return [json.loads(line) for line in (ROOT / name).read_text().splitlines()]


def percentile(values, p):
    values = sorted(values)
    if not values:
        return None
    index = (len(values) - 1) * p
    lo = int(index)
    hi = min(lo + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (index - lo)


def resources(name, start=0, end=float("inf")):
    rows = [row for row in lines(name) if start <= row["ts"] < end]
    rss = [row["rssBytes"] for row in rows if row.get("rssBytes") is not None]
    swap = [row["swapUsedBytes"] for row in rows if row.get("swapUsedBytes") is not None]
    cpu = [row["cpuPercent"] for row in rows if row.get("cpuPercent") is not None]
    gpu = [row["systemGpuInUseBytes"] for row in rows if row.get("systemGpuInUseBytes") is not None]
    return {
        "samples": len(rows),
        "sampleSpanSeconds": rows[-1]["ts"] - rows[0]["ts"] if rows else 0,
        "rssMedianBytes": statistics.median(rss) if rss else None,
        "rssPeakBytes": max(rss) if rss else None,
        "cpuPeakPsPercent": max(cpu) if cpu else None,
        "systemGpuPeakBytes": max(gpu) if gpu else None,
        "healthP50Ms": percentile([row["healthWallMs"] for row in rows], .5),
        "healthP95Ms": percentile([row["healthWallMs"] for row in rows], .95),
        "healthFailures": sum(row.get("healthStatus") != 200 for row in rows),
        "swapDeltaBytes": swap[-1] - swap[0] if swap else None,
    }


events = load("lifecycle.json")
stop = next(row["ts"] for row in events if row["kind"] == "injected_candidate_stop")
final_stop = next(row["ts"] for row in events if row["kind"] == "candidate_stopped")
observations = lines("paced-replay/observations.jsonl")
answered = [row for row in observations if row["failure"] is None]
failures = {}
for row in observations:
    if row["failure"]:
        failures[row["failure"]] = failures.get(row["failure"], 0) + 1
quorum = []
for row in observations:
    counted = [vote for vote in row["incumbentVotes"] or [] if not vote.get("abstained")]
    yes = sum(vote["promote"] for vote in counted)
    quorum.append({
        "decisionId": row["decisionId"], "counted": len(counted),
        "incumbentVerdict": "insufficient" if len(counted) < 2 else ("promote" if yes >= -(-2 * len(counted) // 3) else "no_promote"),
        "candidatePromote": row["candidatePromote"],
    })
report = {
    "status": "aborted_by_health_guard",
    "accuracyMeasured": False,
    "run": load("paced-replay/run.json"),
    "answeredLatencyP50Ms": percentile([row["latencyMs"] for row in answered], .5),
    "answeredLatencyP95Ms": percentile([row["latencyMs"] for row in answered], .95),
    "failures": failures,
    "incumbentHistoricalQuorum": quorum,
    "postRestartInferenceValidated": False,
    "processStartMs": load("nano-ready.json")["processStartMs"],
    "restartReadinessMs": next(row["processStartMs"] for row in events if row["kind"] == "candidate_recovered"),
    "resources": {
        "graniteBaseline": resources("granite-baseline-resources.jsonl", end=load("granite-paused.json")["pausedAtEpoch"]),
        "noJudgeControl": resources("no-judge-control-resources.jsonl", end=load("nano-process.json")["startedAtEpoch"]),
        "nanoBeforeStop": resources("nano-before-recovery-resources.jsonl", end=stop),
        "nanoRestartWindow": resources("nano-after-recovery-resources.jsonl", end=final_stop),
        "restoredGranite": resources("granite-restored-resources.jsonl"),
    },
    "interpretation": "Failed bounded operational window. Health failures overlapped candidate restart without swap growth; host activity is uncontrolled. Four answered short inputs and historical insufficient-quorum ballots do not establish quality, throughput capacity or successful post-restart inference. Fixed cleanup helper passed unit tests; the corrected full supervisor was not rerun.",
}
(ROOT / "analysis.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
