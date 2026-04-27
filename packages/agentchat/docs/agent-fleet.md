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
| groq-llama4-scout (Groq) | 17B/16E | MoE | ✓ | ✓ | ✓ | ✓ | ✓ | **5/5** — smallest 5/5 cloud yet |
| groq-llama-3.3-70b (Groq) | 70B | dense | ✓ | ✓ | ✓ | ✗ "5" | ✓ | **4/5** — over-counts on T7 |
| groq-llama-3.1-8b (Groq) | 8B | dense | ✓ | partial | ✗ false-positive | ✓ | rate-limited | **~2.5/5** — same pathology as NV's 8B |
| groq-gpt-oss-120b (Groq) | 120B | reasoning | budget-exhausted | budget-exhausted | budget-exhausted | budget-exhausted | ✓ "both" | reasoning preamble eats tight max_tokens; needs ≥4K budget |
| groq-qwen3-32b (Groq) | 32B | dense (thinking) | think-leak | think-leak | think-leak | rate-limited | rate-limited | **0/5** — Groq rejects `enable_thinking:false`, raw `<think>` blocks |
| @gemini-flash (CLI, gemini-3-flash-preview) | — | flash | ✓ | ✓ | ✓ | ✓ | ✓ | **5/5** — surprise pure win for the cheap tier; via agentchat dispatch (12-65s/task) |
| @codex-frontier (CLI, gpt-5.2) | — | dense | ✓ | ✓ | ✗ flagged `--attach -file.txt` edge | ✓ | ✓ | **4/5** — T6 disagreement on logical-bug vs argv-convention (real edge case) |
| @codex-mini (CLI, gpt-5.4-mini) | — | mini | ✓ | ✓ | ✗ same `--attach` edge as codex-frontier | ✓ | ✓ | **4/5** — same T6 pattern; fastest of the codex tier (4-33s/task) |
| @gemini-pro-direct (HTTP, gemini-3.1-pro-preview) | — | dense | empty | empty | empty | empty | empty | **uncalibrated** — explicit thinking_budget returns empty content on pro (only default `-1` works, which then consumes max_tokens). Bench-2 not currently runnable on pro-direct. |
| @gemini-flash-direct (HTTP, gemini-3-flash-preview, `thinking_budget:0`) | — | flash | ✓ | ✓ | ✓ NO_BUGS | ✓ | ✓ | **5/5 — at ~1s/task**. With `--extra-body-json '{"extra_body":{"google":{"thinking_config":{"thinking_budget":0}}}}'`, flash matches its CLI sibling's score but ~10× faster (sub-second vs 12-65s). |

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
| Fast cloud general (sub-second latency) | `@groq-llama4-scout` (Groq, smallest 5/5 cloud yet) |
| Cloud 70B-dense general | `@groq-llama-3.3-70b` (Groq, 4/5 — only T7 precision miss) |
| Cheap CLI agent (file-write capable) | `@gemini-flash` — 5/5 on bench-2, cheapest 5/5 of any agent tested. Use as workhorse for file-writing tasks where @gemini's pro tier is overkill. |
| Heavier CLI agent for deep coding | `@codex-frontier` (gpt-5.2) — 4/5; pick over `@codex` for multi-step refactors. The codex-tagged tier (gpt-5.2-codex etc) needs an OpenAI API key — see quirk on agent. |
| Fast stateless dispatch — cheapest 5/5 in the fleet | `@gemini-flash-direct` (with `--extra-body-json '{"extra_body":{"google":{"thinking_config":{"thinking_budget":0}}}}')` — 5/5 on bench-2 at ~1s/task via Google AI Studio HTTP. Beats every other 5/5 in the fleet on speed + cost when no file/shell tools are needed. |
| Qwen-lineage perspective on reasoning | `@local-qwen35-27b` (legacy dense, swap required) |
| Lightweight local fallback | `@local-qwen35-4b` (swap required) |

## AVOID for our profile

- **any Qwen 3.x A3B MoE** (35B base AND coder) — fails T5 reasoning regardless of quant or specialty.
- **NVIDIA `deepseek-v4-pro` / `deepseek-v4-flash`** on free tier — works for trivial prompts, times out at 90s on anything with file context (>~2KB request body).
- **NVIDIA `llama-3.1-8b`** — 2/5; mac-mini Gemma 4 E4B beats it on the same bench at 0 cost.
- **NVIDIA `llama-3.3-nemotron-super-49b-v1.5`** — leaks chain-of-thought into the content field; format adherence broken.
- **Groq `qwen/qwen3-32b`** — 0/5 on Groq specifically. Groq strictly rejects `chat_template_kwargs.enable_thinking:false`, so the model emits raw `<think>` blocks that exhaust the token budget before reaching the answer. Use `nv-qwen3-coder-480b` (NVIDIA accepts the toggle) or local Qwen builds.
- **Groq `openai/gpt-oss-120b`** for tight token budgets — verbose reasoning preamble even at `reasoning_effort=low`. Viable only with `maxTokens` ≥ 4096; not bench-2-shaped.
- **Groq `llama-3.1-8b-instant`** — 2.5/5; same false-positive bug pattern as NVIDIA's 8B, confirms model trait not hosting.

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

# Groq (strict OpenAI-compat — must omit chat_template_kwargs):
GROQ=$(security find-generic-password -s llamactl -a groq -w)
bun packages/agentchat/scripts/bench.ts \
  --label groq-llama4-scout \
  --url https://api.groq.com/openai/v1 \
  --model meta-llama/llama-4-scout-17b-16e-instruct \
  --auth-token "$GROQ" --strict-openai

# Groq reasoning models (gpt-oss-*) — needs --reasoning-effort to leave token budget for the answer:
bun packages/agentchat/scripts/bench.ts \
  --label groq-gpt-oss-120b \
  --url https://api.groq.com/openai/v1 \
  --model openai/gpt-oss-120b \
  --auth-token "$GROQ" --strict-openai --reasoning-effort low

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
- **Within agentchat dispatch specifically**: `@codex` runs in a read-only sandbox — it produces correct design docs but cannot apply `apply_patch` writes; useful for planning, not execution. `@gemini` writes files but cannot run shell side-effects (`chmod`, `git commit`, `bun test`) — recover by running those yourself after. Bench-2-shaped review/plan tasks: prefer `@codex`; file-writing tasks: prefer `@gemini` with a "I'll handle commit + verification" wrapper. (Observed 2026-04-26.)
- **`@nv-qwen3-coder-480b` vs `@nv-llama4-maverick` on long inlined inputs**: maverick handles ~200-line diffs cleanly and produces structured findings; qwen3-coder silently returns empty on the same input. Maverick > qwen3-coder for code-review-style prompts that include the full diff in the user message. For qwen3-coder, pre-summarize or chunk; or use it for narrower coder-specific prompts. (Observed 2026-04-26 stress test.)
- **`@groq-llama4-scout` hallucinates examples** when asked to write docs about something it has no source-of-truth for (e.g. "draft a README section about the `--strict-openai` flag I added"). Bench-2's literal-extraction score does NOT predict source-grounded synthesis. Don't dispatch "write docs about X" without inlining X as a fixture. (Observed 2026-04-26 stress test.)
- **CLI agents through agentchat use bench-2 dispatch** (not direct HTTP) — latencies are 4-65s/task vs 200-1000ms for direct-HTTP cloud agents. Bench results are still ranked-comparable; only absolute latency differs. (Observed 2026-04-27.)
- **`@codex-mini` and `@codex-frontier` share a T6 false-positive bias** — both flagged the same `--attach -file.txt` argv edge case as a "logical bug" where ground truth says NO_BUGS. Not a hallucination (consistent finding across two independent runs); rather a calibration disagreement on bug-vs-convention. The codex review prompted a real fix in commit f467c86 (`@gemini-flash` chose option A: `existsSync` check) — so the codex bias was actually a true positive, just uncovered by a strong gut. (Observed 2026-04-27, fixed same day.)
- **Google AI Studio direct-HTTP gemini-3.x** emits thinking tokens via the OpenAI-compat endpoint that consume `max_tokens` budget BEFORE the answer. Workaround: pass `--extra-body-json '{"extra_body":{"google":{"thinking_config":{"thinking_budget":0}}}}'` to bench.ts (added in commit 8b5b438). Works perfectly for `gemini-3-flash-preview` (5/5). Does NOT work for `gemini-3.1-pro-preview`: any explicit thinking_budget value returns empty content; only the default `-1` (dynamic) produces output, but then thinking still consumes budget. Pro-direct remains bench-uncalibrated until a pro-specific knob is found. (Observed 2026-04-27.)
- **NVIDIA NIM cloud agents** are capped ~40 rpm on free tier — serialize calls when running batches. `/v1/models` is publicly readable without auth, useful for catalog browsing.
- **Groq cloud agents** strictly reject unknown body fields (`chat_template_kwargs`, etc.). The `openai-compat-http` adapter is fine; the bench harness needs `--strict-openai`. Free-tier rate limits hit faster on the small/fast tiers (8B, 32B) — bench's 5 sequential tasks can trip the 5th call.
