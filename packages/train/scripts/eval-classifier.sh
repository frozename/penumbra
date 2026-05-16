#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash packages/train/scripts/eval-classifier.sh <BASE_GGUF> <ADAPTER_GGUF> <TEST_JSONL> <OUT_DIR>
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

if [[ "$#" -ne 4 ]]; then
  usage
  die "expected 4 arguments"
fi

BASE_GGUF=$1
ADAPTER_GGUF=$2
TEST_JSONL=$3
OUT_DIR=$4

for path in "$BASE_GGUF" "$ADAPTER_GGUF" "$TEST_JSONL"; do
  [[ -f "$path" ]] || die "input file not found: $path"
done

mkdir -p "$OUT_DIR"

if [[ -n "${LLAMA_SERVER:-}" ]]; then
  LLAMA_SERVER_BIN="$LLAMA_SERVER"
elif command -v llama-server >/dev/null 2>&1; then
  LLAMA_SERVER_BIN="$(command -v llama-server)"
elif [[ -x "packages/train/vendor/llama.cpp/build/bin/llama-server" ]]; then
  LLAMA_SERVER_BIN="packages/train/vendor/llama.cpp/build/bin/llama-server"
else
  die "llama-server binary not found"
fi

PREDICTIONS_BASE="$OUT_DIR/predictions-base.jsonl"
PREDICTIONS_ADAPTER="$OUT_DIR/predictions-adapter.jsonl"
EVAL_REPORT="$OUT_DIR/EVAL_REPORT.md"
SERVER_LOG_BASE="$OUT_DIR/server-base.log"
SERVER_LOG_ADAPTER="$OUT_DIR/server-adapter.log"
SERVER_PORT=18099
N_PREDICT=150
TEMPERATURE=0.0
MAX_WAIT_SECONDS=180

SERVER_PID=
SERVER_LOG_FILE=
CURRENT_LABEL=

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      kill -9 "$SERVER_PID" >/dev/null 2>&1 || true
    fi
    SERVER_PID=
  fi
}

trap cleanup EXIT INT TERM

canonical_or_fallback() {
  local target=$1
  if command -v realpath >/dev/null 2>&1; then
    realpath "$target" 2>/dev/null || echo "$target"
  else
    echo "$target"
  fi
}

kill_port() {
  local pids
  pids="$(lsof -ti ":$SERVER_PORT" || true)"
  if [[ -n "$pids" ]]; then
    printf '%s\n' "$pids" | xargs -r kill -9
    for _ in $(seq 1 20); do
      if ! lsof -ti ":$SERVER_PORT" >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
  fi
}

wait_for_health() {
  local tries=0
  local max_tries=$((MAX_WAIT_SECONDS))

  until curl -fsS "http://127.0.0.1:${SERVER_PORT}/health" >/dev/null; do
    tries=$((tries + 1))
    if [[ "$tries" -ge "$max_tries" ]]; then
      die "llama-server did not become healthy for ${CURRENT_LABEL} run"
    fi
    sleep 1
  done
}

verify_server_model() {
  local expected=$1
  local log_file=$2

  if ! props=$(curl -fsS "http://127.0.0.1:${SERVER_PORT}/props"); then
    die "failed to fetch /props for ${CURRENT_LABEL} run"
  fi

  local expected_resolved
  local props_model
  local props_resolved
  local expected_base

  expected_resolved="$(canonical_or_fallback "$expected")"
  expected_base="$(basename "$expected")"

  props_model="$(printf '%s' "$props" | jq -r '.model // .model_path // .default_model // empty')"
  if [[ -n "$props_model" && "$props_model" != "null" ]]; then
    props_resolved="$(canonical_or_fallback "$props_model")"
    if [[ "$props_model" != "$expected" && "$props_resolved" != "$expected_resolved" && "$(basename "$props_model")" != "$expected_base" ]]; then
      die "model verification failed for ${CURRENT_LABEL} run: /props=$props_model expected=$expected"
    fi
  elif ! grep -qF "$expected_base" "$log_file"; then
    die "cannot verify loaded model path for ${CURRENT_LABEL} run"
  fi

  if ! grep -qF "$expected" "$log_file" && ! grep -qF "$expected_base" "$log_file"; then
    die "server log does not contain expected model path for ${CURRENT_LABEL} run"
  fi
}

verify_port_owner() {
  local expected_pid=$1
  local log_file=$2

  local pids
  pids="$(lsof -ti ":$SERVER_PORT" || true)"
  if [[ -z "$pids" ]]; then
    die "port ${SERVER_PORT} is not bound for ${CURRENT_LABEL} run"
  fi

  local bound_pid
  bound_pid="$(printf '%s\n' "$pids" | head -n1)"
  if [[ "$bound_pid" != "$expected_pid" ]]; then
    die "port ${SERVER_PORT} bound by unexpected pid ${bound_pid} for ${CURRENT_LABEL} run"
  fi

  local proc_state
  proc_state="$(ps -o stat= -p "$bound_pid" 2>/dev/null | tr -d ' ' || true)"
  if [[ -n "$proc_state" && "${proc_state:0:1}" == "Z" ]]; then
    die "port ${SERVER_PORT} bound by zombie process ${bound_pid} for ${CURRENT_LABEL} run"
  fi

  if ! grep -qF "$expected_pid" "$log_file"; then
    :
  fi
}

extract_first_json_object() {
  printf '%s' "$1" | awk '
    {
      for (i = 1; i <= length($0); i++) {
        ch = substr($0, i, 1)
        if (ch == "{") {
          depth++
        }
        if (depth > 0) {
          obj = obj ch
        }
        if (ch == "}") {
          if (depth > 0) {
            depth--
          }
          if (depth == 0) {
            print obj
            exit 0
          }
        }
      }
    }'
}

normalize_bool() {
  case "${1:-}" in
    true|TRUE|True|1) echo "true" ;;
    false|FALSE|False|0) echo "false" ;;
    *) echo "" ;;
  esac
}

extract_gold() {
  printf '%s\n' "$1" | jq -r '.memory_related // .gold // .label // (try (.completion | fromjson | .memory_related) catch empty) // empty'
}

extract_pred_from_response_obj() {
  local response_obj=$1

  local pred_raw=""
  pred_raw="$(printf '%s' "$response_obj" | jq -r '
    .memory_related //
    (try (.completion | fromjson | .memory_related) catch empty) //
    (try (fromjson | .memory_related) catch empty) //
    (try (.content | fromjson | .memory_related) catch empty) //
    empty
  ' 2>/dev/null || true)"

  printf '%s' "$pred_raw"
}

run_completion_eval() {
  local model=$1
  local lora=$2
  local out_file=$3
  local label=$4

  CURRENT_LABEL=$label
  local log_file="$OUT_DIR/server-${label}.log"
  SERVER_LOG_FILE=$log_file

  rm -f "$out_file"

  kill_port
  rm -f "$log_file"

  local lora_args=()
  if [[ -n "$lora" ]]; then
    lora_args+=("--lora" "$lora")
  fi

  local cmd=("$LLAMA_SERVER_BIN" --port "$SERVER_PORT" --host 127.0.0.1 --model "$model" "${lora_args[@]}")
  "${cmd[@]}" >"$log_file" 2>&1 &
  SERVER_PID=$!

  sleep 1
  wait_for_health
  verify_port_owner "$SERVER_PID" "$log_file"
  verify_server_model "$model" "$log_file"

  if [[ -n "$lora" ]]; then
    if ! grep -q "llama_adapter_lora_init_impl: loading lora adapter" "$log_file"; then
      die "missing adapter init marker in adapter run server log"
    fi
  fi

  local idx=0
  local total=0
  local parsed_count=0
  local correct=0
  local tp=0
  local fp=0
  local fn=0
  local tn=0
  local rows
  local row
  local row_index=0

  mapfile -t rows < "$TEST_JSONL"

  for row in "${rows[@]}"; do
    row_index=$((row_index + 1))
    idx=$((idx + 1))
    total=$((total + 1))

    local prompt
    local gold
    local pred_raw=""
    local parsed=false
    local pred=""
    local pred_norm=""
    local gold_norm=""
    local response
    local response_file
    local http_code
    local response_head
    local payload
    local response_obj

    prompt="$(printf '%s\n' "$row" | jq -r '.prompt // .input // empty')"
    if [[ -z "$prompt" ]]; then
      prompt="$(printf '%s\n' "$row" | jq -r '.text // empty')"
    fi

    gold="$(extract_gold "$row")"
    gold_norm="$(normalize_bool "$gold")"

    payload="$(jq -n --arg p "$prompt" --argjson n "$N_PREDICT" --argjson t "$TEMPERATURE" '{prompt: $p, n_predict: $n, temperature: $t, cache_prompt: true}')"

    response=""
    http_code=""
    for _ in $(seq 1 60); do
      response_file="$(mktemp)"
      http_code="$(curl -sS -w '%{http_code}' -o "$response_file" -H 'Content-Type: application/json' -d "$payload" "http://127.0.0.1:${SERVER_PORT}/completion")"
      response="$(cat "$response_file")"
      rm -f "$response_file"
      if [[ "$http_code" == "200" ]]; then
        break
      fi
      if [[ "$http_code" == "503" ]]; then
        sleep 0.5
        continue
      fi
      break
    done
    if [[ "$http_code" != "200" ]]; then
      response=""
    fi

    response_head="$(printf '%s' "$response" | tr '\n' ' ' | cut -c 1-180)"

    response_obj="$(extract_first_json_object "$response")"
    if [[ -n "$response_obj" ]]; then
      pred_raw="$(extract_pred_from_response_obj "$response_obj")"
    fi
    pred_norm="$(normalize_bool "$pred_raw")"

    if [[ -n "$pred_norm" ]]; then
      parsed=true
      parsed_count=$((parsed_count + 1))
    fi

    if [[ "$parsed" == "true" && -n "$gold_norm" ]]; then
      if [[ "$pred_norm" == "$gold_norm" ]]; then
        correct=$((correct + 1))
      fi

      if [[ "$pred_norm" == "true" && "$gold_norm" == "true" ]]; then
        tp=$((tp + 1))
      elif [[ "$pred_norm" == "true" && "$gold_norm" == "false" ]]; then
        fp=$((fp + 1))
      elif [[ "$pred_norm" == "false" && "$gold_norm" == "true" ]]; then
        fn=$((fn + 1))
      else
        tn=$((tn + 1))
      fi
    fi

    local pred_json
    pred_json="$(jq -nc \
      --argjson i "$idx" \
      --arg gold "$gold_norm" \
      --arg parsed "$parsed" \
      --arg pred "$pred_norm" \
      --arg head "$response_head" \
      '{idx: $i, gold: (if $gold == "true" then true elif $gold == "false" then false else null end), parsed: ($parsed == "true"), pred: (if $pred == "true" then true elif $pred == "false" then false else null end), response_head: $head}')"
    printf '%s\n' "$pred_json" >>"$out_file"
  done

  if [[ "$total" -eq 0 ]]; then
    die "empty test file: $TEST_JSONL"
  fi

  kill -9 "$SERVER_PID" >/dev/null 2>&1 || true
  SERVER_PID=

  local accuracy precision recall f1 parse_rate
  local pos_count
  local pos_in_gold
  pos_count=$((tp + fn))
  if [[ "$total" -eq 0 ]]; then
    accuracy="0.0000"
  else
    accuracy="$(awk -v c="$correct" -v t="$total" 'BEGIN { printf "%.4f", c / t }')"
  fi
  if [[ "$tp" -eq 0 && "$fp" -eq 0 ]]; then
    precision="0.0000"
  else
    precision="$(awk -v tp="$tp" -v fp="$fp" 'BEGIN { printf "%.4f", tp / (tp + fp) }')"
  fi
  if [[ "$tp" -eq 0 && "$fn" -eq 0 ]]; then
    recall="0.0000"
  else
    recall="$(awk -v tp="$tp" -v fn="$fn" 'BEGIN { printf "%.4f", tp / (tp + fn) }')"
  fi
  if [[ "$(awk -v p="$precision" -v r="$recall" 'BEGIN { if ((p + r) == 0) print "1"; else print "0" }')" == "1" ]]; then
    f1="0.0000"
  else
    f1="$(awk -v p="$precision" -v r="$recall" 'BEGIN { printf "%.4f", (2 * p * r) / (p + r) }')"
  fi
  parse_rate="$(awk -v p="$parsed_count" -v t="$total" 'BEGIN { printf "%.4f", p / t }')"

  printf '%s\n' "$parsed_count|$correct|$tp|$fp|$fn|$accuracy|$precision|$recall|$f1|$parse_rate|$total|$idx|$pos_count"
}

collect_disagreements() {
  local base_file=$1
  local adapter_file=$2
  local max_items=5
  local count=0

  while IFS=$'\t' read -r base_line adapter_line; do
    local idx
    local gold
    local base_pred
    local adapter_pred
    local base_head
    local adapter_head
    local base_head_json
    local adapter_head_json
    idx="$(printf '%s' "$base_line" | jq -r '.idx')"
    gold="$(printf '%s' "$base_line" | jq -r '.gold // null')"
    base_pred="$(printf '%s' "$base_line" | jq -r '.pred // null')"
    adapter_pred="$(printf '%s' "$adapter_line" | jq -r '.pred // null')"
    base_head="$(printf '%s' "$base_line" | jq -r '.response_head // ""')"
    adapter_head="$(printf '%s' "$adapter_line" | jq -r '.response_head // ""')"
    base_head_json="$(printf '%s' "$base_head" | jq -R .)"
    adapter_head_json="$(printf '%s' "$adapter_head" | jq -R .)"

    if [[ "$base_pred" != "$adapter_pred" ]]; then
      printf '%s\n' "[$idx, $gold, $base_pred, $adapter_pred, $base_head_json, $adapter_head_json]"
      count=$((count + 1))
      if [[ "$count" -ge "$max_items" ]]; then
        break
      fi
    fi
  done < <(paste "$base_file" "$adapter_file")
}

echo "running adapter eval..."
read -r ADAPTER_METRICS <<<"$(run_completion_eval "$BASE_GGUF" "$ADAPTER_GGUF" "$PREDICTIONS_ADAPTER" adapter)"

read -r BASE_METRICS <<<"$(run_completion_eval "$BASE_GGUF" "" "$PREDICTIONS_BASE" base)"

IFS='|' read -r ADP_PARSED ADP_CORRECT ADP_TP ADP_FP ADP_FN ADP_ACC ADP_PREC ADP_RECALL ADP_F1 ADP_PARSE_RATE ADP_TOTAL ADP_IDX ADP_POS <<<"$ADAPTER_METRICS"
IFS='|' read -r BASE_PARSED BASE_CORRECT BASE_TP BASE_FP BASE_FN BASE_ACC BASE_PREC BASE_RECALL BASE_F1 BASE_PARSE_RATE BASE_TOTAL BASE_IDX BASE_POS <<<"$BASE_METRICS"

if [[ "$ADP_TOTAL" -ne "$BASE_TOTAL" ]]; then
  die "row count mismatch between runs: adapter=$ADP_TOTAL base=$BASE_TOTAL"
fi

DELTA_ACC="$(awk -v a="$ADP_ACC" -v b="$BASE_ACC" 'BEGIN { printf "%.4f", a - b }')"
DELTA_PREC="$(awk -v a="$ADP_PREC" -v b="$BASE_PREC" 'BEGIN { printf "%.4f", a - b }')"
DELTA_RECALL="$(awk -v a="$ADP_RECALL" -v b="$BASE_RECALL" 'BEGIN { printf "%.4f", a - b }')"
DELTA_F1="$(awk -v a="$ADP_F1" -v b="$BASE_F1" 'BEGIN { printf "%.4f", a - b }')"
DELTA_PARSE="$(awk -v a="$ADP_PARSE_RATE" -v b="$BASE_PARSE_RATE" 'BEGIN { printf "%.4f", a - b }')"

POSITIVE_COUNT="$(jq -r '.memory_related // .gold // .label // (try (.completion | fromjson | .memory_related) catch empty)' "$TEST_JSONL" | awk 'tolower($0)=="true"{p++} END {print p+0}')"
NEGATIVE_COUNT="$(jq -r '.memory_related // .gold // .label // (try (.completion | fromjson | .memory_related) catch empty)' "$TEST_JSONL" | awk 'tolower($0)=="false"{n++} END {print n+0}')"

BASE_SIZE=$(stat -f %z "$BASE_GGUF")
BASE_MTIME=$(stat -f '%Sm' "$BASE_GGUF")
ADAPTER_SIZE=$(stat -f %z "$ADAPTER_GGUF")
ADAPTER_MTIME=$(stat -f '%Sm' "$ADAPTER_GGUF")

cat >"$EVAL_REPORT" <<EOF
# Memory-efficacy binary classifier eval

## Setup
- Base GGUF: $BASE_GGUF
- Adapter GGUF: $ADAPTER_GGUF (size=$ADAPTER_SIZE, mtime=$ADAPTER_MTIME)
- Test rows: $BASE_TOTAL (${POSITIVE_COUNT:-0} positive / ${NEGATIVE_COUNT:-0} negative)
- llama-server: $LLAMA_SERVER_BIN
- n_predict: $N_PREDICT, temperature: $TEMPERATURE

## Results
|        | accuracy | precision (T) | recall (T) | F1 (T) | parse rate |
|--------|----------|---------------|------------|--------|------------|
| base   | $BASE_ACC | $BASE_PREC | $BASE_RECALL | $BASE_F1 | $BASE_PARSE_RATE |
| adapter| $ADP_ACC | $ADP_PREC | $ADP_RECALL | $ADP_F1 | $ADP_PARSE_RATE |
| delta  | $DELTA_ACC | $DELTA_PREC | $DELTA_RECALL | $DELTA_F1 | $DELTA_PARSE |

## Sample disagreements (first 5 rows where adapter ≠ base)
[$(
  collect_disagreements "$PREDICTIONS_BASE" "$PREDICTIONS_ADAPTER" | sed -n '1,5p'
)]
EOF

echo "Wrote $EVAL_REPORT"
cat "$EVAL_REPORT"
echo "Adapter run log: $SERVER_LOG_ADAPTER"
echo "Base run log: $SERVER_LOG_BASE"
