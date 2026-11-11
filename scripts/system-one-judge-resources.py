#!/usr/bin/env python3
"""Read-only macOS process/host sampler. Never starts or stops inference services."""
import argparse
import json
import re
import subprocess
import time
import urllib.request


def command(argv):
    try:
        return subprocess.check_output(argv, text=True, stderr=subprocess.DEVNULL, timeout=4)
    except (subprocess.SubprocessError, OSError):
        return ""


def sample(pid, health_url):
    row = {"ts": time.time(), "pid": pid}
    ps = command(["ps", "-p", str(pid), "-o", "rss=,%cpu="]).split()
    row.update(rssBytes=int(ps[0]) * 1024 if ps else None,
               cpuPercent=float(ps[1]) if len(ps) > 1 else None)
    vm = command(["vm_stat"])
    page_size = re.search(r"page size of (\d+)", vm)
    page_size = int(page_size[1]) if page_size else 16384
    for name, key in [("Pages free", "freeBytes"), ("Pages occupied by compressor", "compressedBytes"), ("Swapins", "swapins"), ("Swapouts", "swapouts")]:
        match = re.search(re.escape(name) + r":\s+(\d+)", vm)
        row[key] = int(match[1]) * (page_size if "Bytes" in key else 1) if match else None
    swap = re.search(r"used = ([\d.]+)M", command(["sysctl", "vm.swapusage"]))
    row["swapUsedBytes"] = float(swap[1]) * 1024 * 1024 if swap else None
    gpu = command(["ioreg", "-r", "-c", "AGXAccelerator", "-d", "1"])
    for name, key in [("Device Utilization %", "systemGpuUtilizationPercent"), ("In use system memory", "systemGpuInUseBytes"), ("Alloc system memory", "systemGpuAllocatedBytes")]:
        match = re.search('"' + re.escape(name) + r'"=(\d+)', gpu)
        row[key] = int(match[1]) if match else None
    start = time.monotonic()
    try:
        with urllib.request.urlopen(health_url, timeout=2) as response:
            data = json.load(response)
            row.update(healthStatus=response.status, daemonLagMs=data.get("lagMs"))
    except Exception as error:
        row.update(healthStatus=None, healthError=type(error).__name__)
    row["healthWallMs"] = (time.monotonic() - start) * 1000
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", required=True, type=int)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seconds", type=float, default=180)
    parser.add_argument("--health-url", default="http://127.0.0.1:51257/health")
    args = parser.parse_args()
    if args.pid < 1 or not 0 < args.seconds <= 3600:
        parser.error("invalid pid or duration")
    end = time.monotonic() + args.seconds
    with open(args.out, "w", encoding="utf-8") as output:
        while time.monotonic() < end:
            started = time.monotonic()
            row = sample(args.pid, args.health_url)
            output.write(json.dumps(row) + "\n")
            output.flush()
            if row["rssBytes"] is None:
                break
            time.sleep(max(0, 1 - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
