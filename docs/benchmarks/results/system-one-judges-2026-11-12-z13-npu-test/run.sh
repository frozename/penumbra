#!/usr/bin/env bash
set -euo pipefail

MODEL=${1:-lite}
SUITE=${2:-canary}
ACTION=${3:-dry-run}
TRANSPORT=${4:-close}
case "$MODEL" in lite|nano) ;; *) exit 2 ;; esac
case "$SUITE" in canary|public|reviewed|t2) ;; *) exit 2 ;; esac
case "$ACTION" in dry-run|execute) ;; *) exit 2 ;; esac
case "$TRANSPORT" in default|close) ;; *) exit 2 ;; esac
TEST_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$TEST_DIR" rev-parse --show-toplevel)
REMOTE=/home/alex/DevStorage/penumbra-system-one-npu-test-20261112
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
UNIT=penumbra-npu-trial-$MODEL-$STAMP-$$
OUT="$TEST_DIR/runs/$MODEL-$SUITE-$TRANSPORT-$STAMP"
if [ "$SUITE" = canary ]; then
  FIXTURES="$TEST_DIR/canary.jsonl"
elif [ "$SUITE" = public ]; then
  FIXTURES="$REPO/docs/benchmarks/fixtures/system-one-source-reviewed.jsonl"
elif [ "$SUITE" = t2 ]; then
  FIXTURES=/Volumes/AI-DATA/maestro/bench/system-one-judges-20261111/review-200/t2-confirmatory-fixtures.jsonl
else
  FIXTURES=/Volumes/AI-DATA/maestro/bench/system-one-judges-20261111/review-200/ai-reviewed-judges-v2.jsonl
fi
mkdir -p "$OUT"
python3 - "$TEST_DIR" "$REPO" "$SUITE" "$FIXTURES" <<'PY' | tee "$OUT/selection.json"
from pathlib import Path
import sys,json
sys.path.insert(0,sys.argv[1])
from trial_guard import validate_fixture_bytes
test,repo,suite,fixtures=map(Path,sys.argv[1:])
manifest=json.loads((repo/'docs/benchmarks/results/system-one-judges-2026-11-11-production-readiness/reviewed-fixture-manifest.json').read_text())
if str(suite)=='canary':
    count,sha=20,json.loads((test/'input-manifest.json').read_text())['selectedFixtureSha256']
elif str(suite)=='t2':
    t2=json.loads((repo/'docs/benchmarks/results/system-one-judges-2026-11-11-production-readiness/t2-confirmatory-manifest.json').read_text())
    count,sha=t2['selected'],t2['privateFixtureRawSha256']
else:
    count,sha=(320,manifest['privateRawSha256']) if str(suite)=='reviewed' else (120,manifest['publicRawSha256'])
print(json.dumps(dict(validate_fixture_bytes(fixtures.read_bytes(),count,sha),suite=str(suite),fixturePath=str(fixtures))))
PY
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
python3 - "$TEST_DIR" <<'PY'
import sys
sys.path.insert(0,sys.argv[1])
from trial_guard import assert_port_available
assert_port_available(18945)
PY
ssh z13 python3 "$REMOTE/gufo_probe.py" > "$OUT/gufo-before.json"
ssh -S none -o ControlMaster=no -o ControlPersist=no -o ExitOnForwardFailure=yes -o BatchMode=yes -N -L 127.0.0.1:18945:127.0.0.1:52625 z13 > "$OUT/tunnel.log" 2>&1 &
TUNNEL_PID=$!
STARTED_UNIT=1
ssh z13 systemd-run --user --unit="$UNIT" --collect \
  --property=MemoryHigh=4G --property=MemoryMax=6G --property=MemorySwapMax=0 \
  --property=CPUQuota=200% --property=TasksMax=128 --property=RuntimeMaxSec=600 \
  --property=TimeoutStopSec=10 --property=KillMode=control-group \
  --property=StandardOutput=journal --property=StandardError=journal \
  /usr/bin/choom -n 800 -- /usr/bin/python3 "$REMOTE/guarded_runtime.py" \
  --root "$REMOTE" --model "$MODEL" --out "$REMOTE/runs/$UNIT" > "$OUT/start.log" 2>&1
python3 - "$MODEL" "$REMOTE/runs/$UNIT/guard.json" > "$OUT/api-readiness.json" <<'PY'
import json,sys,time,urllib.request,subprocess
expected='d3:'+sys.argv[1]
started=time.time()
deadline=time.monotonic()+90
last_guard_check=0
while time.monotonic()<deadline:
    if time.monotonic()-last_guard_check>3:
        last_guard_check=time.monotonic()
        try:
            probe=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=2','z13','cat',sys.argv[2]],capture_output=True,text=True,timeout=3)
            guard=json.loads(probe.stdout) if probe.returncode==0 else None
            if guard and guard.get('status')=='aborted':raise SystemExit('NPU supervisor aborted: '+str(guard.get('reason')))
        except (subprocess.TimeoutExpired,ValueError):pass
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
EXTRA=()
if [ "$TRANSPORT" = close ]; then EXTRA+=(--connection-close); fi
bun "$TEST_DIR/replay.ts" --config "$TEST_DIR/$MODEL-config.json" --fixtures "$FIXTURES" --out "$OUT" "${EXTRA[@]}" > "$OUT/bench.log" 2>&1
wait "$PROBE_PID"
PROBE_PID=
ssh z13 systemctl --user stop "$UNIT"
STARTED_UNIT=0
ssh z13 python3 "$REMOTE/gufo_probe.py" > "$OUT/gufo-after.json"
scp -q "z13:$REMOTE/runs/$UNIT/*" "$OUT/"
python3 "$TEST_DIR/summarize.py" "$OUT" "$FIXTURES"
printf '%s\n' "$OUT"
