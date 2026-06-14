# Llama.cpp shared n-gram cache A/B handoff runbook (2026-05-14)

## Branch and commit

- `llama.cpp-atomic` branch: `fix/shared-ngram-cache-dynamic`
- commit: `84ae116a2`

## Build artifacts

- Baseline binary: `/Volumes/WorkSSD/src/llama.cpp/build/bin/llama-server`
- Patched binary: `/Volumes/WorkSSD/src/llama.cpp-atomic/build-shared-cache/bin/llama-server`
- Model used in this run: `granite-4.1-3b-Q6_K.gguf`

## A/B command reference

- Baseline (no shared n-gram cache rewrite):
  ```bash
  /Volumes/WorkSSD/src/llama.cpp/build/bin/llama-server \
    --model /Volumes/WorkSSD/ai-models/llama.cpp/models/granite-4.1-3b-GGUF/granite-4.1-3b-Q6_K.gguf \
    --port 18888 \
    --spec-type ngram-cache \
    --lookup-cache-dynamic /tmp/mtp-baseline-cache.bin \
    -np 2 \
    --ctx-size 2048
  ```

- Patched:
  ```bash
  /Volumes/WorkSSD/src/llama.cpp-atomic/build-shared-cache/bin/llama-server \
    --model /Volumes/WorkSSD/ai-models/llama.cpp/models/granite-4.1-3b-GGUF/granite-4.1-3b-Q6_K.gguf \
    --port 18888 \
    --spec-type ngram-cache \
    --lookup-cache-dynamic /tmp/mtp-shared-cache.bin \
    -np 2 \
    --ctx-size 2048
  ```

- Targeted round-trip test script:
  ```bash
  /Volumes/WorkSSD/src/llama.cpp-atomic/scripts/mtp-lcd-shared-cache-roundtrip.sh \
    /Volumes/WorkSSD/src/llama.cpp/build/bin/llama-server \
    /Volumes/WorkSSD/src/llama.cpp-atomic/build-shared-cache/bin/llama-server \
    /Volumes/WorkSSD/ai-models/llama.cpp/models/granite-4.1-3b-GGUF/granite-4.1-3b-Q6_K.gguf
  ```

## Baseline vs patched expectation

- Health check:
  - `curl -fsS http://127.0.0.1:18888/health` should return JSON.
  - simple smoke completion request should return HTTP 200.
- On shutdown, parse these log lines:
  - `slot 0 speculative counters: ...`
  - `slot 1 speculative counters: ...`
- Expected:
  - unpatched: `slot 1` counters line may be missing in this mode (no shared-dynamic path)
  - patched: `slot 1` should include `n_lookup_dynamic_hits>0`

## Rollback

- Repoint workload to baseline binary and port:
  - baseline command above or old launcher/maestro task.
- Preserve same model and `-np 2`.
- Optionally keep cache file paths separate (`/tmp/mtp-baseline-cache.bin*`) to avoid stale reuse.

## Known risk callouts

- shared cache growth is unbounded for long-running sessions; monitor memory and rotate/clear cache path if needed.
- if `--lookup-cache-dynamic` file cannot be read, startup fails early.
- if one slot remains idle/underutilized, slot assignment may affect hit rates during short runs.
