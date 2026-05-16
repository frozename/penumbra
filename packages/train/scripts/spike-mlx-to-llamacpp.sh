#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPIKE_WORK_DIR="$ROOT_DIR/.spike-work"
SPIKE_CORPUS_DIR="$SPIKE_WORK_DIR/corpus"
SPIKE_ADAPTER_OUT="$SPIKE_WORK_DIR/memory-efficacy-0.5b"
mkdir -p "$SPIKE_CORPUS_DIR" "$SPIKE_ADAPTER_OUT"
python3 - "$SPIKE_CORPUS_DIR" "$ROOT_DIR/data/dummy.jsonl" <<'PY'
import json
from pathlib import Path

import sys

target_dir = Path(sys.argv[1])
source = Path(sys.argv[2])

rows = []
for line in source.read_text().splitlines():
  line = line.strip()
  if not line:
    continue
  payload = json.loads(line)
  prompt = (
    payload.get("instruction")
    or payload.get("prompt")
    or payload.get("text")
    or ""
  ).strip()
  completion = (
    payload.get("output")
    or payload.get("completion")
    or payload.get("response")
    or ""
  ).strip()
  if prompt:
    rows.append({"prompt": prompt, "completion": completion})

for name in ("train", "valid"):
  (target_dir / f"{name}.jsonl").write_text(
    "\n".join(json.dumps(r) for r in rows) + "\n"
  )
PY

export ITERS=20
export BATCH_SIZE=1
export NUM_LAYERS=4
export LORA_RANK=16
export REPORT_FILE="$ROOT_DIR/SPIKE_REPORT.md"
export REPORT_LABEL="SPIKE"

bash "$ROOT_DIR/scripts/train-lora.sh" \
  "Qwen/Qwen2.5-0.5B-Instruct@7ae557604adf67be50417f59c2c2f167def9a775" \
  "$SPIKE_CORPUS_DIR" \
  "$SPIKE_ADAPTER_OUT"
