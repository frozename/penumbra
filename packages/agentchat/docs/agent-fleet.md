# Agent fleet — calibration + routing reference

Operating reference for picking the right agent for a task. Calibration data and routing recommendations come from `bench-2`, run via `packages/agentchat/scripts/bench.ts` against each candidate model.

## Bench-2 tasks (5 micro-benchmarks)

Each model is evaluated on:

| Task | Tests |
|---|---|
| T4 | long-context retrieval (READ from a 250-line file, return one integer) |
| T5 | multi-step reasoning (predict behavior of a lock + semaphore under contention) |
| T6 | format under tension (clean file: must answer `NO_BUGS` and resist nit-drift) |
| T7 | precision counting (exact occurrence count of a string) |
| T8 | disambiguation (mutex / semaphore / both — pick one word) |

## Results (2026-04-26)

| Model | Active params | Type | T4 | T5 | T6 | T7 | T8 | Net |
|---|---|---|---|---|---|---|---|---|
| Gemma 4 E4B (mac-mini) | 4B | dense | ✓ | ✓ | ✓ | ✓ | ✓ | **5/5** |
| Qwen 3.5 4B Q4_K_XL | 4B | dense | ✓ | ✓ | ✓ | ✓ | ✓ | **5/5** |
| Gemma 4 26B-A4B Q4_K_XL | 4B active | MoE A4B | ✓ | ✓ | ✓ | ✓ | ✓ | **5/5** |
| Gemma 4 31B Q4_K_XL | 31B | dense | pedantic | ✓ | ✓ | ✓ | ✓ | **5/5** |
| Qwen 3.5 27B Q5_K_XL | 27B | dense | ✓ | ✓ | ✓ | ✓ | ✓ | **5/5** |
| Qwen 3.6 27B Q4_K_XL | 27B | dense | ✓ | ✓ | ✓ | ✗ 3 | ✓ | **4/5** |
| Qwen 3.6 35B-A3B Q4_K_M | 3B active | MoE A3B | ✓ | ✗ logic backwards | ✓ | ✗ 3 | ✓ | **3/5** |
| Qwen 3.6 35B-A3B Q4_K_XL | 3B active | MoE A3B | ✓ | ✗ logic backwards | ✓ | ✗ 3 | ✓ | **3/5** |
| Qwen3-Coder-30B-A3B Q4_K_XL (local) | 3B active | MoE A3B (coder) | ✓ | ✗ logic backwards | ✓ | ✓ | ✓ | **4/5** |
| nv-llama4-maverick (NVIDIA) | 17B/128E | MoE | ✓ | ✓ | ✓ | ✓ | ✓ | **5/5** |
| nv-qwen3-coder-480b (NVIDIA) | 35B active | MoE A35B (coder) | ✓ | ✓ | ✓ | ✓ | ✓ | **5/5** |
| nv-llama-3.1-8b (NVIDIA) | 8B | dense | ✓ | ✓ | ✗ false-positive | rate-limited | ✗ "semaphore" | **2/5** |
| nv-deepseek-v4-pro (NVIDIA) | — | — | rate-limited | ✓ | rate-limited | ✓ | rate-limited | times-out at >2KB prompts |
| nv-nemotron-super-49b (NVIDIA) | 49B | dense (reasoning) | format-fail | format-fail | format-fail | format-fail | format-fail | leaks chain-of-thought into content |

T4 was poorly specified — README only *shows* `--concurrency 4` in an example, never *states* the default. Smaller Gemmas inferred from context (practical); Gemma 4 31B refused (pedantic). Both are defensible.

## Architecture pattern

**Qwen 3.x A3B MoE (3B active) consistently fails T5 reasoning.** Quant doesn't fix it (Q4_K_M and Q4_K_XL behave identically). Coder specialty doesn't fix it (Qwen3-Coder-30B-A3B shows the same pathology). The 3B active routing is too thin for our task profile. The 480B coder variant on NVIDIA (35B active) clears the bar — A3B vs A35B is the load-bearing distinction.

Dense models — across every size and series tested (4B → 31B) — are reliable on this bench. MoE works when the active path is wide enough (Gemma 4 A4B, Qwen3 A35B).

## Sweet-spot pairings

| Task profile | Pick |
|---|---|
| Quick extraction / yes-no / format-strict (low cost) | mac-mini Gemma 4 E4B (`@planner` or `@executor`) |
| Code review / multi-step reasoning / focused single-file dives | local Gemma 4 26B-A4B MoE (`@local-gemma26`) |
| Pedantic literal-vs-implied (e.g. spec compliance check) | local Gemma 4 31B dense (`@local-gemma31`, swap required) |
| Frontier general / vision (cloud) | `@nv-llama4-maverick` (NVIDIA, free-tier ~40 rpm) |
| Frontier coder (cloud) | `@nv-qwen3-coder-480b` (NVIDIA — clears the A3B blind spot) |
| Qwen-lineage perspective on reasoning | `@local-qwen35-27b` (legacy dense, swap required) |
| Lightweight local fallback | `@local-qwen35-4b` (swap required) |

## AVOID for our profile

- **any Qwen 3.x A3B MoE** (35B base AND coder) — fails T5 reasoning regardless of quant or specialty.
- **NVIDIA `deepseek-v4-pro` / `deepseek-v4-flash`** on free tier — works for trivial prompts, times out at 90s on anything with file context (>~2KB request body).
- **NVIDIA `llama-3.1-8b`** — 2/5; mac-mini Gemma 4 E4B beats it on the same bench at 0 cost.
- **NVIDIA `llama-3.3-nemotron-super-49b-v1.5`** — leaks chain-of-thought into the content field; format adherence broken.

## Reproducing the calibration

```bash
# Local llama-server (swap target via llamactl):
bun packages/agentchat/scripts/bench.ts \
  --label gemma4-26b \
  --url http://127.0.0.1:8080/v1 \
  --model local

# NVIDIA NIM (replace with your nvapi key reference):
NVAPI=$(security find-generic-password -s llamactl -a nvidia -w)
bun packages/agentchat/scripts/bench.ts \
  --label nv-qwen3-coder-480b \
  --url https://integrate.api.nvidia.com/v1 \
  --model qwen/qwen3-coder-480b-a35b-instruct \
  --auth-token "$NVAPI"

# Mac-mini gemma (self-signed CA):
bun packages/agentchat/scripts/bench.ts \
  --label gemma4-e4b-mac-mini \
  --url https://192.168.68.76:7843/v1 \
  --model gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf \
  --auth-token "$LLAMACTL_TOKEN_MAC_MINI" \
  --auth-cert /tmp/llamactl-mac-mini-ca.pem
```

Each invocation prints one JSON line per task to stdout. To compare a new model against the table, eyeball the `answer` vs `groundTruth` fields and update the row above.

## Per-agent quirks

The agentchat config (`~/.config/agentchat/agentchat.yaml`) carries a `quirks` field per agent — empirical observations from past use. When routing, scan those before dispatch. Highlights:

- **mac-mini Gemma 4 E4B** drifts into style nits if the prompt allows; tighten constraints. Punches above 4B weight.
- **local Gemma 4 26B-A4B MoE** tends to label "concern" findings as "bug"; re-read its findings before acting.
- **Gemma 4 31B (dense)** is pedantic — says "not specified" where smaller gemmas infer values. Use this exact behavior when literal correctness matters.
- **`@gemini` / `@claude` / `@codex`** are agentic CLIs with native file/shell tools — they'll write files but unreliable on per-task git commits via agentchat. Always verify with `git status` after.
- **NVIDIA NIM cloud agents** are capped ~40 rpm on free tier — serialize calls when running batches. `/v1/models` is publicly readable without auth, useful for catalog browsing.
