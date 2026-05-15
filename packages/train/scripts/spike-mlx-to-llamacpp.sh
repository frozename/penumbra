#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
VENDOR_DIR="$ROOT_DIR/vendor/llama.cpp"
REPORT_FILE="$ROOT_DIR/SPIKE_REPORT.md"
DATA_FILE="$ROOT_DIR/data/dummy.jsonl"
WORK_DIR="$ROOT_DIR/.spike-work"
MODEL_DIR="$WORK_DIR/model"
ADAPTER_DIR="$WORK_DIR/adapter"
PEFT_DIR="$WORK_DIR/peft"
GGUF_DIR="$WORK_DIR/gguf"
MODEL_URLS=(
  "mlx-community/Qwen2.5-0.5B-Instruct-4bit"
  "Qwen/Qwen3-0.6B-Base"
  "Qwen/Qwen2.5-0.5B-Instruct"
  "Qwen/Qwen2.5-0.5B"
)

mkdir -p "$WORK_DIR" "$MODEL_DIR" "$ADAPTER_DIR" "$PEFT_DIR" "$GGUF_DIR"

cat > "$REPORT_FILE" <<'EOF'
# SPIKE REPORT

Status: PARTIAL

EOF

if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi

PYTHON="$VENV_DIR/bin/python"
PIP="$VENV_DIR/bin/pip"

if [ -x "$PYTHON" ]; then
  "$PYTHON" - <<'PY' >> "$REPORT_FILE"
import importlib.util
mods = ["mlx_lm", "peft", "transformers", "torch"]
missing = [m for m in mods if importlib.util.find_spec(m) is None]
print("Missing Python packages:", ", ".join(missing) if missing else "none")
PY
fi

if [ ! -d "$VENDOR_DIR/.git" ]; then
  git clone --depth 1 https://github.com/ggerganov/llama.cpp.git "$VENDOR_DIR"
fi

LLAMA_SERVER="/Users/acordeiro/.llamactl/bin/llama-server"
if [ ! -x "$LLAMA_SERVER" ]; then
  LLAMA_SERVER="$VENDOR_DIR/build/bin/llama-server"
  if [ ! -x "$LLAMA_SERVER" ]; then
    cmake -S "$VENDOR_DIR" -B "$VENDOR_DIR/build" -DLLAMA_BUILD_SERVER=ON -DLLAMA_BUILD_TESTS=OFF
    cmake --build "$VENDOR_DIR/build" --target llama-server -j2
  fi
fi

printf '%s\n' "Using llama-server: $LLAMA_SERVER" >> "$REPORT_FILE"
printf '%s\n' "Data rows: $(wc -l < "$DATA_FILE")" >> "$REPORT_FILE"

cat >> "$REPORT_FILE" <<'EOF'

Model fallback chain:
mlx-community/Qwen2.5-0.5B-Instruct-4bit
Qwen/Qwen3-0.6B-Base
Qwen/Qwen2.5-0.5B-Instruct
Qwen/Qwen2.5-0.5B
EOF

cat >> "$REPORT_FILE" <<'EOF'

Conversion rules:
- MLX `.lora_a` -> `base_model.model.*.lora_A.weight`
- MLX `.lora_b` -> `base_model.model.*.lora_B.weight`
- Both tensors are transposed before PEFT export.
- `adapter_config.json` is rewritten to PEFT LORA schema.
EOF

echo "SPIKE: PARTIAL" >> "$REPORT_FILE"
