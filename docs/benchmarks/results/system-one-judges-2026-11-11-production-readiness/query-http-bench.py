"""Isolated Bun HTTP/event-loop regression test on the private snapshot."""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
SNAPSHOT = "/Volumes/AI-DATA/maestro/bench/system-one-judges-20261111/production-readiness/control-plane-snapshot.sqlite"
results = []
for variant, iterations in [("legacy", 2), ("grouped", 50)]:
    child = subprocess.Popen(["bun", str(ROOT / "query-http-harness.mjs"), "--db", SNAPSHOT, "--legacy", str(ROOT / "legacy-p4-queries.json"), "--variant", variant], cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        info = json.loads(child.stdout.readline())
        base = f'http://127.0.0.1:{info["port"]}'
        def workload():
            requests = []
            for _ in range(iterations):
                with urllib.request.urlopen(base + "/work", timeout=30) as response:
                    requests.append(json.load(response))
                time.sleep(.1)
            return requests
        probes = []
        started = time.time()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(workload)
            while not pending.done():
                tick = time.monotonic()
                try:
                    with urllib.request.urlopen(base + "/health", timeout=.2) as response:
                        status = response.status
                except Exception:
                    status = None
                probes.append({"offsetSeconds": time.time() - started, "status": status, "wallMs": (time.monotonic() - tick) * 1000})
                time.sleep(.1)
            requests = pending.result()
        results.append({"variant": variant, "iterations": iterations, "elapsedSeconds": time.time() - started, "healthTimeoutMs": 200, "healthFailures": sum(row["status"] != 200 for row in probes), "probes": probes, "requests": requests})
    finally:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=1)
report = {"methodology": "Separate loopback Bun servers, same read-only two-table snapshot; repeated real P4 SQL synchronously in the server event loop; a separate Python thread polls health. Legacy 2 work requests vs grouped 50 is a stress/regression comparison, not a throughput ratio. Full CI was concurrently running on the host; production daemon/model services were untouched.", "results": results}
(ROOT / "query-http-benchmark.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({row["variant"]: {"requests": len(row["requests"]), "healthProbes": len(row["probes"]), "healthFailures": row["healthFailures"], "elapsedSeconds": row["elapsedSeconds"]} for row in results}))
