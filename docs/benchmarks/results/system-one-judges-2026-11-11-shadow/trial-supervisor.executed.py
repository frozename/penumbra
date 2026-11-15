"""One-run supervisor for the recorded, loopback-only candidate; restores Granite."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
events = []
candidate = json.loads((ROOT / "nano-process.json").read_text())
observer = json.loads((ROOT / "observer-process.json").read_text())
candidate_pid = candidate["pid"]
recovery = False
stopped_at = None
sampler = None
aborted = False


def record(kind, **details):
    events.append({"ts": time.time(), "kind": kind, **details})
    (ROOT / "lifecycle.json").write_text(json.dumps(events, indent=2) + "\n")


def available(port):
    with socket.socket() as sock:
        sock.settimeout(.2)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def stop_candidate(pid):
    actual = subprocess.check_output(["ps", "-p", str(pid), "-o", "args="], text=True).strip()
    assert shlex.split(actual) == candidate["command"], "candidate identity changed"
    assert candidate["command"][candidate["command"].index("--port") + 1] == "18944"
    os.kill(pid, signal.SIGTERM)
    for _ in range(100):
        if not available(18944):
            return
        time.sleep(.1)
    raise RuntimeError("candidate did not stop")


def ready(port, seconds=30):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=.5) as response:
                if response.status == 200:
                    return
        except Exception:
            pass
        time.sleep(.1)
    raise RuntimeError(f"readiness timeout on {port}")


def samples():
    rows = []
    for name in ("nano-before-recovery-resources.jsonl", "nano-after-recovery-resources.jsonl"):
        path = ROOT / name
        if path.exists():
            for line in path.read_text().splitlines():
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return sorted(rows, key=lambda row: row["ts"])


try:
    record("supervisor_started", candidatePid=candidate_pid, observerPid=observer["pid"])
    while not (ROOT / "paced-replay/run.json").exists():
        rows = samples()
        if len(rows) >= 2:
            last = rows[-2:]
            baseline_swap = rows[0].get("swapUsedBytes")
            swap = rows[-1].get("swapUsedBytes")
            if all(row.get("healthStatus") != 200 for row in last):
                raise RuntimeError("two consecutive daemon health failures")
            if baseline_swap is not None and swap is not None and swap - baseline_swap > 256 * 1024**2:
                raise RuntimeError("swap growth exceeded 256 MiB")
        if time.time() - observer["startedAtEpoch"] > 750:
            raise RuntimeError("trial exceeded 750-second bound")
        if not recovery and time.time() - observer["startedAtEpoch"] >= 100:
            stop_candidate(candidate_pid)
            stopped_at = time.time()
            recovery = True
            record("injected_candidate_stop", pid=candidate_pid)
        if stopped_at is not None and time.time() - stopped_at >= 40:
            started = time.time()
            with (ROOT / "nano-server-recovery.log").open("w") as log:
                process = subprocess.Popen(["nice", "-n", "10", *candidate["command"]], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            candidate_pid = process.pid
            with (ROOT / "recovery-sampler.log").open("w") as log:
                sampler = subprocess.Popen(["python3", "scripts/system-one-judge-resources.py", "--pid", str(candidate_pid), "--seconds", "650", "--out", str(ROOT / "nano-after-recovery-resources.jsonl")], cwd=REPO, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            ready(18944)
            record("candidate_recovered", pid=candidate_pid, processStartMs=(time.time() - started) * 1000)
            stopped_at = None
        time.sleep(1)
    record("observer_completed")
except Exception as error:
    aborted = True
    record("trial_aborted", reason=str(error))
    try:
        os.kill(observer["pid"], signal.SIGTERM)
    except ProcessLookupError:
        pass
finally:
    if available(18944):
        stop_candidate(candidate_pid)
        record("candidate_stopped", pid=candidate_pid)
    if sampler is not None:
        sampler.wait(timeout=10)
    original = Path("/tmp/penumbra-systemone-granite-original-command.txt").read_text().strip()
    pause = json.loads((ROOT / "granite-paused.json").read_text())
    assert hashlib.sha256(original.encode()).hexdigest() == pause["originalCommandSha256"]
    if not available(8086):
        with (ROOT / "granite-restoration.log").open("w") as log:
            process = subprocess.Popen(shlex.split(original), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        ready(8086)
        actual = subprocess.check_output(["ps", "-p", str(process.pid), "-o", "args="], text=True).strip()
        assert shlex.split(actual) == shlex.split(original)
        record("granite_restored", pid=process.pid, sameBinaryModelFlags=True, healthStatus=200)
    else:
        record("granite_already_listening_no_action")
    record("supervisor_finished", aborted=aborted)
