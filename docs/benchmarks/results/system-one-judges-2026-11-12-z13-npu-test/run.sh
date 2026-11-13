#!/usr/bin/env bash
set -euo pipefail

MODEL=${1:-lite}
SUITE=${2:-canary}
ACTION=${3:-dry-run}
case "$MODEL" in lite|nano) ;; *) exit 2 ;; esac
case "$SUITE" in canary|reviewed) ;; *) exit 2 ;; esac
case "$ACTION" in dry-run|execute) ;; *) exit 2 ;; esac
TEST_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$TEST_DIR" rev-parse --show-toplevel)
REMOTE=/home/alex/DevStorage/penumbra-system-one-npu-test-20261112
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
UNIT=penumbra-npu-trial-$MODEL-$STAMP-$$
OUT="$TEST_DIR/runs/$MODEL-$SUITE-$STAMP"
if [ "$SUITE" = canary ]; then
  FIXTURES="$TEST_DIR/canary.jsonl"
else
  FIXTURES="$REPO/docs/benchmarks/fixtures/system-one-source-reviewed.jsonl"
fi
if [ "$ACTION" = dry-run ]; then
  cd "$REPO"
  bun scripts/system-one-judge-bench.ts --config "$TEST_DIR/$MODEL-config.json" --fixtures "$FIXTURES" --out "$OUT" --concurrency 1 --repeats 1
  exit
fi

mkdir -p "$OUT"
STARTED_UNIT=0
TUNNEL_PID=
PROBE_PID=
cleanup() {
  ORIGINAL_EXIT=$?
  set +e
  if [ "$STARTED_UNIT" = 1 ]; then ssh z13 systemctl --user stop "$UNIT"; fi
  if [ -n "$PROBE_PID" ]; then wait "$PROBE_PID" || true; fi
  if [ -n "$TUNNEL_PID" ]; then kill "$TUNNEL_PID" 2>/dev/null || true; wait "$TUNNEL_PID" 2>/dev/null || true; fi
  scp -q "z13:$REMOTE/runs/$UNIT/*" "$OUT/" 2>/dev/null || true
  python3 "$TEST_DIR/summarize.py" "$OUT" "$FIXTURES" > "$OUT/classification.log" 2>&1
  CLASSIFY_EXIT=$?
  if [ "$ORIGINAL_EXIT" = 0 ]; then exit "$CLASSIFY_EXIT"; fi
  exit "$ORIGINAL_EXIT"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

scp -q "$TEST_DIR/trial_guard.py" "$TEST_DIR/guarded_runtime.py" "$TEST_DIR/gufo_probe.py" "z13:$REMOTE/"
python3 - <<'PY'
import socket
with socket.socket() as probe:
    probe.bind(('127.0.0.1',18945))
PY
ssh z13 python3 "$REMOTE/gufo_probe.py" > "$OUT/gufo-before.json"
ssh -o ExitOnForwardFailure=yes -o BatchMode=yes -N -L 127.0.0.1:18945:127.0.0.1:52625 z13 > "$OUT/tunnel.log" 2>&1 &
TUNNEL_PID=$!
STARTED_UNIT=1
ssh z13 systemd-run --user --unit="$UNIT" --collect \
  --property=MemoryHigh=4G --property=MemoryMax=6G --property=MemorySwapMax=0 \
  --property=CPUQuota=200% --property=TasksMax=128 --property=RuntimeMaxSec=600 \
  --property=TimeoutStopSec=10 --property=KillMode=control-group \
  --property=StandardOutput=journal --property=StandardError=journal \
  /usr/bin/choom -n 800 -- /usr/bin/python3 "$REMOTE/guarded_runtime.py" \
  --root "$REMOTE" --model "$MODEL" --out "$REMOTE/runs/$UNIT" > "$OUT/start.log" 2>&1
python3 - "$MODEL" > "$OUT/api-readiness.json" <<'PY'
import json,sys,time,urllib.request
expected='d3:'+sys.argv[1]
started=time.time()
deadline=time.monotonic()+90
while time.monotonic()<deadline:
    try:
        with urllib.request.urlopen('http://127.0.0.1:18945/v1/systemone/models',timeout=1) as r:
            models=json.load(r)
        if any(x.get('id')==expected for x in models.get('data',[])):
            print(json.dumps({'apiAdvertisedModel':True,'models':models,'startedAt':started,'advertisedAt':time.time(),'waitedMs':(time.time()-started)*1000,'caveat':'Route/model advertisement; first validated inference is measured by the benchmark.'}))
            break
    except Exception: pass
    time.sleep(0.25)
else: raise SystemExit('NPU runtime did not become ready within90s')
PY
ssh z13 python3 "$REMOTE/gufo_probe.py" > "$OUT/gufo-during.json" &
PROBE_PID=$!
cd "$REPO"
bun scripts/system-one-judge-bench.ts --config "$TEST_DIR/$MODEL-config.json" --fixtures "$FIXTURES" --out "$OUT" --live --concurrency 1 --repeats 1 > "$OUT/bench.log" 2>&1
wait "$PROBE_PID"
PROBE_PID=
ssh z13 systemctl --user stop "$UNIT"
STARTED_UNIT=0
ssh z13 python3 "$REMOTE/gufo_probe.py" > "$OUT/gufo-after.json"
scp -q "z13:$REMOTE/runs/$UNIT/*" "$OUT/"
python3 "$TEST_DIR/summarize.py" "$OUT" "$FIXTURES"
printf '%s\n' "$OUT"
