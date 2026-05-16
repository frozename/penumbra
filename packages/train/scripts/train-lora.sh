#!/usr/bin/env bash
set -euo pipefail

MODEL="${1:-}"
CORPUS_DIR="${2:-}"
ADAPTER_OUT="${3:-}"

if [ -z "$MODEL" ] || [ -z "$CORPUS_DIR" ] || [ -z "$ADAPTER_OUT" ]; then
  echo "usage: $0 MODEL CORPUS_DIR ADAPTER_OUT" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
VENDOR_DIR="$ROOT_DIR/vendor/llama.cpp"
WORK_DIR="$ADAPTER_OUT"
HF_BASE_DIR="$WORK_DIR/hf-base"
MLX_ADAPTER_DIR="$WORK_DIR/mlx-adapter"
PEFT_ADAPTER_DIR="$WORK_DIR/peft-adapter"
GGUF_DIR="$WORK_DIR/gguf"

ITERS="${ITERS:-100}"
BATCH_SIZE="${BATCH_SIZE:-1}"
NUM_LAYERS="${NUM_LAYERS:-8}"
LORA_RANK="${LORA_RANK:-16}"
PORT="${PORT:-18099}"
LLAMA_SERVER="${LLAMA_SERVER:-}"
REPORT_FILE="${REPORT_FILE:-$WORK_DIR/TRAIN_REPORT.md}"
REPORT_LABEL="${REPORT_LABEL:-TRAIN}"

LOG_DIR="$WORK_DIR/logs"
mkdir -p "$WORK_DIR" "$HF_BASE_DIR" "$MLX_ADAPTER_DIR" "$PEFT_ADAPTER_DIR" "$GGUF_DIR" "$LOG_DIR"

LLAMA_CPP_SHA="49d1701bd24e4cedf6dfec9e50e185111203946b"
PIP_PINS=(
  "mlx-lm==0.31.3"
  "safetensors==0.7.0"
  "numpy==2.4.5"
  "huggingface_hub==1.15.0"
  "torch==2.12.0"
  "transformers==5.8.1"
  "sentencepiece==0.2.1"
  "gguf==0.19.0"
  "protobuf==7.34.1"
  "pytest==8.3.4"
)

if [[ "$MODEL" == *"@"* ]]; then
  MODEL_REPO="${MODEL%@*}"
  MODEL_REVISION="${MODEL##*@}"
else
  MODEL_REPO="$MODEL"
  MODEL_REVISION=""
fi

status="PASS"
status_reason="all four steps green"
step_train="PENDING"
step_bridge="PENDING"
step_convert="PENDING"
step_smoke="PENDING"
train_rows=0
valid_rows=0
rename_lines=""
smoke_json_file="$LOG_DIR/smoke-results.json"
lora_config_file="$LOG_DIR/lora-config.yml"
server_pid=""

cleanup() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

log() {
  printf '\n[train-lora] %s\n' "$*" >&2
}

if [ -d "$WORK_DIR/model" ]; then
  rm -rf "$WORK_DIR/model"
fi

if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi
PYTHON="$VENV_DIR/bin/python"
PIP="$VENV_DIR/bin/pip"

log "install/update Python dependencies"
"$PIP" install --quiet --upgrade pip
"$PIP" install --quiet "${PIP_PINS[@]}"

log "pin/clone llama.cpp @$LLAMA_CPP_SHA"
if [ ! -d "$VENDOR_DIR/.git" ]; then
  git clone https://github.com/ggml-org/llama.cpp.git "$VENDOR_DIR"
fi
git -C "$VENDOR_DIR" fetch --quiet origin "$LLAMA_CPP_SHA" || true
git -C "$VENDOR_DIR" checkout --quiet "$LLAMA_CPP_SHA"
LLAMA_COMMIT="$(git -C "$VENDOR_DIR" rev-parse HEAD)"

if [ -n "$LLAMA_SERVER" ] && [ -x "$LLAMA_SERVER" ]; then
  llama_server_source="ENV ($LLAMA_SERVER)"
else
  candidate="$(command -v llama-server 2>/dev/null || true)"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    LLAMA_SERVER="$candidate"
    llama_server_source="PATH ($candidate)"
  else
    LLAMA_SERVER="$VENDOR_DIR/build/bin/llama-server"
    if [ ! -x "$LLAMA_SERVER" ]; then
      cmake -S "$VENDOR_DIR" -B "$VENDOR_DIR/build" -DGGML_BUILD_TESTS=OFF -DGGML_METAL=ON \
        > "$LOG_DIR/cmake-configure.log" 2>&1
      cmake --build "$VENDOR_DIR/build" --target llama-server -j2 \
        > "$LOG_DIR/cmake-build.log" 2>&1
    fi
    llama_server_source="vendor build ($LLAMA_SERVER)"
  fi
fi

log "fetch HF model $MODEL_REPO ${MODEL_REVISION:+@ $MODEL_REVISION}"
rm -rf "$HF_BASE_DIR"
if [ ! -f "$CORPUS_DIR/train.jsonl" ] || [ ! -f "$CORPUS_DIR/valid.jsonl" ]; then
  status="FAIL"
  status_reason="corpus missing train.jsonl or valid.jsonl"
  step_train="SKIP"
  step_bridge="SKIP"
  step_convert="SKIP"
  step_smoke="SKIP"
  {
    echo "# TRAIN REPORT"
    echo
    echo "Status: $status"
    echo "Reason: $status_reason"
    echo
    echo "## Environment"
    echo "- Model: $MODEL"
    echo "- Corpus: $CORPUS_DIR"
    echo "- ITERS: $ITERS"
    echo "- BATCH_SIZE: $BATCH_SIZE"
    echo "- NUM_LAYERS: $NUM_LAYERS"
    echo "- LORA_RANK: $LORA_RANK"
    echo "- Port: $PORT"
    echo "- llama.cpp SHA: $LLAMA_COMMIT"
    echo "- Train rows: -"
    echo "- Valid rows: -"
    echo "- Python: $("$PYTHON" --version 2>&1)"
    echo
  } > "$REPORT_FILE"
  echo "$REPORT_LABEL: $status $status_reason"
  exit 1
fi

hf_exit_code=0
if [ -n "$MODEL_REVISION" ]; then
  "$VENV_DIR/bin/hf" download "$MODEL_REPO" --revision "$MODEL_REVISION" --local-dir "$HF_BASE_DIR" \
    > "$LOG_DIR/hf-download.log" 2>&1 || hf_exit_code=$?
else
  "$VENV_DIR/bin/hf" download "$MODEL_REPO" --local-dir "$HF_BASE_DIR" \
    > "$LOG_DIR/hf-download.log" 2>&1 || hf_exit_code=$?
fi
if [ "$hf_exit_code" -ne 0 ]; then
  status="FAIL"
  status_reason="failed to fetch model from Hugging Face"
fi

if [ "$status" = "FAIL" ]; then
  step_train="FAIL"
  {
    echo "# TRAIN REPORT"
    echo
    echo "Status: $status"
    echo "Reason: $status_reason"
    echo
    echo "## Environment"
    echo "- Model: $MODEL"
    echo "- Corpus: $CORPUS_DIR"
    echo "- ITERS: $ITERS"
    echo "- BATCH_SIZE: $BATCH_SIZE"
    echo "- NUM_LAYERS: $NUM_LAYERS"
    echo "- LORA_RANK: $LORA_RANK"
    echo "- Port: $PORT"
    echo "- llama.cpp SHA: $LLAMA_COMMIT"
    echo "- llama-server: $LLAMA_SERVER"
    echo "- Train rows: -"
    echo "- Valid rows: -"
    echo "- Python: $("$PYTHON" --version 2>&1)"
    echo
  } > "$REPORT_FILE"
  echo "$REPORT_LABEL: $status $status_reason"
  exit 1
fi

train_rows="$("$PYTHON" - "$CORPUS_DIR/train.jsonl" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
rows = sum(1 for line in path.read_text().splitlines() if line.strip())
print(rows)
PY
)"
valid_rows="$("$PYTHON" - "$CORPUS_DIR/valid.jsonl" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
rows = sum(1 for line in path.read_text().splitlines() if line.strip())
print(rows)
PY
)"

cat <<EOF > "$lora_config_file"
lora_parameters:
  rank: $LORA_RANK
  scale: 20.0
  dropout: 0.0
EOF

log "train step (ITERS=$ITERS, BATCH_SIZE=$BATCH_SIZE, NUM_LAYERS=$NUM_LAYERS, LORA_RANK=$LORA_RANK)"
t0=$(date +%s)
if "$PYTHON" -m mlx_lm.lora --model "$HF_BASE_DIR" --train \
  --data "$CORPUS_DIR" --iters "$ITERS" --batch-size "$BATCH_SIZE" \
  --num-layers "$NUM_LAYERS" --adapter-path "$MLX_ADAPTER_DIR" --config "$lora_config_file" \
  > "$LOG_DIR/train.log" 2>&1; then
  step_train="PASS"
else
  step_train="FAIL"
  status="FAIL"
  status_reason="step 1 failed: train"
fi
train_sec=$(( $(date +%s) - t0 ))

if [ "$step_train" = "PASS" ]; then
  log "bridge step"
  t0=$(date +%s)
  if "$PYTHON" "$ROOT_DIR/src/bridge/mlx_to_peft.py" "$MLX_ADAPTER_DIR" "$PEFT_ADAPTER_DIR" \
    > "$LOG_DIR/bridge.log" 2>&1; then
    step_bridge="PASS"
    rename_lines="$(grep '→' "$LOG_DIR/bridge.log" | head -4 || true)"
  else
    step_bridge="FAIL"
    status="FAIL"
    status_reason="step 2 failed: bridge"
  fi
  bridge_sec=$(( $(date +%s) - t0 ))
else
  bridge_sec=0
fi

if [ "$step_bridge" = "PASS" ]; then
  log "convert step"
  t0=$(date +%s)
  base_gguf="$GGUF_DIR/base.gguf"
  adapter_gguf="$GGUF_DIR/adapter.gguf"
  convert_ok=1
  "$PYTHON" "$VENDOR_DIR/convert_hf_to_gguf.py" "$HF_BASE_DIR" \
    --outfile "$base_gguf" --outtype f16 > "$LOG_DIR/base-convert.log" 2>&1 || convert_ok=0
  if [ "$convert_ok" = "1" ]; then
    "$PYTHON" "$VENDOR_DIR/convert_lora_to_gguf.py" --base "$HF_BASE_DIR" \
      --outfile "$adapter_gguf" --outtype f16 "$PEFT_ADAPTER_DIR" \
      > "$LOG_DIR/lora-convert.log" 2>&1 || convert_ok=0
  fi
  if [ "$convert_ok" = "1" ] && [ -f "$base_gguf" ] && [ -f "$adapter_gguf" ]; then
    step_convert="PASS"
  else
    step_convert="FAIL"
    status="FAIL"
    status_reason="step 3 failed: convert"
  fi
  convert_sec=$(( $(date +%s) - t0 ))
else
  convert_sec=0
fi

if [ "$step_convert" = "PASS" ]; then
  log "smoke step on :$PORT"
  t0=$(date +%s)
  "$LLAMA_SERVER" --model "$GGUF_DIR/base.gguf" --lora "$GGUF_DIR/adapter.gguf" \
    --port "$PORT" --no-webui > "$LOG_DIR/server.log" 2>&1 &
  server_pid=$!

  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if "$PYTHON" - "$PORT" "$CORPUS_DIR/valid.jsonl" "$smoke_json_file" <<'PY'
import json
import pathlib
import sys
import re
import urllib.request
from urllib.error import HTTPError, URLError


def parse_markdown_json(value: str) -> bool:
  if not isinstance(value, str):
    return False
  if not value.strip():
    return False
  try:
    json.loads(value.strip())
    return True
  except Exception:
    pass
  fenced = re.search(r"```json\s*(\{[\s\S]*?\})\s*```", value)
  if not fenced:
    return False
  try:
    json.loads(fenced.group(1))
    return True
  except Exception:
    return False


port = int(sys.argv[1])
valid_path = pathlib.Path(sys.argv[2])
out_path = pathlib.Path(sys.argv[3])

url = f"http://127.0.0.1:{port}/v1/chat/completions"
headers = {"Content-Type": "application/json"}
samples = []
json_parse_hits = 0
ok = False

prompts = []
for line in valid_path.read_text().splitlines():
  line = line.strip()
  if not line:
    continue
  try:
    payload = json.loads(line)
  except json.JSONDecodeError:
    continue
  prompt = payload.get("prompt")
  if isinstance(prompt, str):
    prompts.append(prompt)
  if len(prompts) >= 3:
    break

for prompt in prompts:
  request_body = json.dumps({
    "model": "local",
    "messages": [{"role": "user", "content": prompt}],
    "max_tokens": 120,
    "temperature": 0.0,
  }).encode("utf-8")

  raw = ""
  parse_ok = False
  content = ""
  err = ""
  try:
    req = urllib.request.Request(
      url,
      data=request_body,
      headers=headers,
      method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
      raw = resp.read().decode("utf-8", errors="replace")
    obj = json.loads(raw)
    if isinstance(obj, dict) and "choices" in obj and obj["choices"]:
      content = obj["choices"][0].get("message", {}).get("content", "")
      if isinstance(content, str):
        parse_ok = parse_markdown_json(content)
        if parse_ok:
          json_parse_hits += 1
          ok = True
  except (URLError, HTTPError, json.JSONDecodeError, OSError, TimeoutError) as e:
    err = repr(e)

  samples.append({
    "prompt": prompt,
    "response_raw_sample": raw[:200],
    "response_content_sample": str(content)[:200],
    "response_parsed_as_json": parse_ok,
    "error": err,
  })

  if not ok:
    ok = json_parse_hits > 0

out_path.write_text(json.dumps({
  "samples": samples,
  "parsed_json_count": json_parse_hits,
  "status": "PASS" if ok else "FAIL",
}, indent=2))
if not ok:
  raise SystemExit(1)
PY
  then
    step_smoke="PASS"
    smoke_rows="$("$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1])).get("parsed_json_count", 0))' "$smoke_json_file")"
  else
    step_smoke="FAIL"
    status="FAIL"
    status_reason="step 4 failed: smoke"
    smoke_rows="0"
  fi
  serve_sec=$(( $(date +%s) - t0 ))
else
  serve_sec=0
  smoke_rows="0"
fi

{
  echo "# TRAIN REPORT"
  echo
  echo "Status: $status"
  if [ "$status" = "FAIL" ]; then
    echo "Reason: $status_reason"
  fi
  echo
  echo "## Environment"
  echo "- Model: $MODEL"
  echo "- Corpus: $CORPUS_DIR"
  echo "- ITERS: $ITERS"
  echo "- BATCH_SIZE: $BATCH_SIZE"
  echo "- NUM_LAYERS: $NUM_LAYERS"
  echo "- LORA_RANK: $LORA_RANK"
  echo "- Port: $PORT"
  echo "- llama.cpp SHA: $LLAMA_COMMIT"
  echo "- llama-server: $LLAMA_SERVER ($llama_server_source)"
  echo "- Train rows: $train_rows"
  echo "- Valid rows: $valid_rows"
  echo "- Python: $("$PYTHON" --version 2>&1)"
  echo
  echo "## Steps"
  echo "| Step | Result | Wall |"
  echo "|---|---|---|"
  echo "| train | $step_train | ${train_sec}s |"
  echo "| bridge | $step_bridge | ${bridge_sec}s |"
  echo "| convert | $step_convert | ${convert_sec}s |"
  echo "| smoke | $step_smoke | ${serve_sec}s |"
  echo
  echo "## Smoke test"
  echo "- Parsed JSON samples: $smoke_rows"
  if [ -f "$smoke_json_file" ]; then
    echo "- Smoke sample payload: $smoke_json_file"
  else
    echo "- Smoke sample payload: not available"
  fi
  echo
  echo "## Conversion notes"
  echo '```'
  echo "${rename_lines:-none}"
  echo '```'
  echo
} > "$REPORT_FILE"

echo "$REPORT_LABEL: $status ${status_reason:+$status_reason}"
if [ "$status" = "PASS" ]; then
  exit 0
fi
exit 1
