# Penumbra Fleet Model Reorganization — Proposal

**Date:** 2026-06-02
**Status:** Awaiting operator sign-off (this is a proposal; no config has been edited)
**Scope:** Classification correctness + usage-balancing/routing + cost-bound corrections across all 69 agents.
**Out of scope (hard fences):** promotion/near-dup dreaming gates (commit 77680828, env-gated default-off — leave unset), silent-failure-retry classification and the `reliability_status` taxonomy, and any worker-side adapter/model/args change without a planned worker restart.

---

## 0. Executive summary

The operator goal is "balance usage across the whole fleet and respect each agent's REAL limits (subscription quota/pressure vs API rpm + per-token cost)." Four findings shape everything below:

1. **USD quotas are display-only for subscriptions.** `quotaStatus()` keys `used_usd` off `cost_usd_billed` (rows where `lane='cloud'`). Subscription CLI/ACP work is written as `cost_usd_synth` (`lane='cli-subscription'`) and does **not** decrement the USD quota. The `$50` Anthropic / `$25` Google / `$10` OpenCode-Go ceilings are synthetic display budgets. Real governance for subscriptions is the **pressure caps only**. (`packages/core/src/readers/cost-quota.ts`, `cost.ts`.)

2. **Only Anthropic + Google have live pressure feeds.** `checkPressureCap()` returns `pricing_mode_skip` for any non-subscription agent and `no_signal` for any provider without a snapshot. **OpenAI (9 agents) and OpenCode-Go (14 agents) — the two largest subscription pools — have no `pressure_caps` block and therefore cannot be refused today.** (`packages/core/src/maestro/check-pressure-cap.ts`.)

3. **Routing has no load-spread, no rpm, no marginal-cost term.** `chooseSingle`/`buildRank` rank on historical outcome/rounds/smoke/reviewer/maestro scores. Cost only enters at weight `0.05` and only from billed rows (null for subscriptions). Pressure is a **binary filter at `used_pct >= 0.9`** (`isOverPressure`) — a cliff, not a gradient. There is **no per-agent rpm/concurrency field anywhere in the schema** (`packages/agentchat/src/config/types.ts` has only `cost_cents_per_run`, `tier`, tags, provider-level `pressure_caps`). So "respect API rpm" is **not expressible in config** — it is a code follow-up, not part of this rebalance.

4. **The default exploration policy is `unsampled-first`** (`types.ts`), which actively prefers never-sampled agents. Broadening role eligibility without first deny-listing the broken set (`nv-deepseek-v4-pro`, `groq-qwen3-32b`) and the untested set (`codex-frontier`, `codex-mini`, `gemini-flash`) would make the router preferentially pick exactly the agents that fail — a self-inflicted outage.

**Consequence for the design.** Because the router has no spreading term and cannot see API rpm, "balance" is achieved through **config levers** (role-list breadth + `unsampled-first` rotation + tiered `default_roles` + persona spread + per-agent subscription caps), with the **free local/llamactl fleet as the load sink** — NOT by pushing volume onto the unmetered API pay-go tier (which we cannot rate-protect) and NOT onto other subscription agents (which would just trip a different pressure cap). One optional code change (a headroom multiplier in `agent-routing.ts`) would make true quota-weighted spread real; it is flagged as a deferred follow-up, not a prerequisite.

---

## 1. Ideal classification table (all 69 agents)

Legend — `CHANGE?`: **no** = correct today; **yes** = field correction / role / cap / retire, described inline.

`pricing_mode` reflects the *accounting rail*: subscription agents draw a plan governed by pressure caps; `api` agents are pay-go/free-tier governed by rpm + per-token billing. Note the Google split: `gemini-*` subscription agents draw Code Assist token caps; `gemini-pro-direct`/`gemini-flash-direct` are `api_provider: google` and hit the billed USD rail — same vendor, two unrelated budgets.

### Table 1 — Subscription agents (33 in live file; see §1.3 count reconciliation)

| # | Agent | pricing_mode | provider | model (ideal) | roles (ideal) | tags (add) | maestro | CHANGE? |
|---|---|---|---|---|---|---|---|---|
| 1 | claude | subscription | anthropic | sonnet | [planner] | — | false | **no** |
| 2 | claude-acp-sonnet | subscription | anthropic | sonnet | [reviewer] | +recall_context | true | **yes** — is review_synthesizer + plan_synthesizer + carries 2 personas after spread; add `recall_context` (gap vs other ACP agents, Issue #8). Reviewer role made explicit so agent_rank sees the load it carries. |
| 3 | claude-acp-haiku | subscription | anthropic | haiku | [executor] | +recall_context | true | **yes** — roles `[]` today ("until benched"); assign `[executor]` (cheap Anthropic tier) so it absorbs load instead of leaving sonnet to drain the plan. Add `recall_context`. |
| 4 | home-mgmt (LL) | subscription | anthropic | haiku | n/a (long-lived) | — | n/a | **yes** — add `bounds.cost_cents` (none today) + widen cron; see §4. |
| 5 | task-refiner-primary (LL) | subscription | anthropic | haiku | n/a | — | n/a | **yes** — `initial_agent: claude-acp-fast` is correct (claude-acp-fast IS in the fleet — see note). cost_cents 20 OK; recalibrate per §4. |
| 6 | task-refiner-escalation (LL) | subscription | anthropic | haiku | n/a | — | n/a | **yes** — recalibrate cost_cents per §4. |
| 7 | codex | subscription | openai | gpt-5.4 | [reviewer] | — | false | **no** |
| 8 | codex-frontier | subscription | openai | gpt-5.2 | [] until benched | +`untested-hold` | false | **yes** — tag untested; exclude from routing until benched (Issue #10). |
| 9 | codex-spark | subscription | openai | gpt-5.3-codex-spark | [executor,reviewer] | — | false | **no** — model still exists; correct. |
| 10 | codex-mini | subscription | openai | gpt-5.4-mini | [] until benched | +`untested-hold` | false | **yes** — tag untested; exclude until benched. |
| 11 | codex-acp-gpt-5.4 | subscription | openai | gpt-5.4 | [] | +`deprecated-do-not-route` | **false** | **yes — RETIRE/QUARANTINE** — deprecated, `maestro_capable: true` + no roles = phantom maestro slot. Set `maestro_capable: false` (additive, reversible) first; delete block after a transition window. (Issue #2.) |
| 12 | codex-acp | subscription | openai | (inherits config.toml) | [executor] | — | true | **yes** — drop `reviewer` (overlaps codex-acp-deep); make this the default OpenAI executor lane. (Issue #5.) |
| 13 | codex-acp-fast | subscription | openai | gpt-5.4-mini (low) | [executor] | — | true | **no** — cheap fast lane; recall_context already present. |
| 14 | codex-acp-deep | subscription | openai | **gpt-5.5** (high) | [reviewer] | — | true | **no** — re-pin to gpt-5.5 already correct (gpt-5.3-codex removed). Primary reviewer of record. Do NOT revert toward gpt-5.3-codex. |
| 15 | codex-acp-spark | subscription | openai | gpt-5.3-codex-spark (med) | [executor] | — | true | **yes** — roles `[implementer]` (line 1298) is a non-routable role string; normalize to `[executor]`. (Issue #5.) |
| 16 | gemini | subscription | google | gemini-3.1-pro-preview | [reviewer] | — | false | **no** field change, but **removed as `default_roles.reviewer`** (§2) — it draws the tightest cap in the fleet (pro 250K/24h + 50K/5h). |
| 17 | gemini-flash | subscription | google | gemini-3-flash-preview | [] until benched | +`untested-hold` | false | **yes** — tag untested; exclude until benched. |
| 18 | gemini-acp-pro | subscription | google | gemini-3.1-pro-preview | [executor] | +[cloud,acp,has-tools]; +per-agent 5h cap | true | **yes** — working workhorse this session; thin tags. Add a per-agent 5h token cap reflecting the 50K/5h ceiling (§4) so it self-sheds before the whole google provider trips. Route bulk to flash, not pro. |
| 19 | gemini-cli-3-5-flash | subscription | google | gemini-3-5-flash (agy-cli) | [reviewer,planner] | +`chat-only-no-acp` | false | **yes** — tag so router never sends it file/shell work (agy v1.0.0 has no --acp). recall_context already present. (Issue #3.) |
| 20 | gemini-acp-flash | subscription | google | **gemini-3-flash-preview** | [executor] | +[cloud,acp,has-tools] | true | **yes — FIX DESCRIPTION** — line 1008 says "gemini-2.5-flash" but args (line 1011) run gemini-3-flash-preview. Fix the *description to match the args*, never the reverse (2.5 family 429s). (Issue #3, R13.) |
| 21 | oc-big-pickle | subscription | opencode-go | big-pickle | [planner,reviewer] | — | **true** | **yes** — free-tier planner/reviewer; make maestro_capable=true for parity with paid OC and to balance load off the paid pool. (Issue #7 — see Open Decision OD-3.) |
| 22 | oc-gpt-5-nano | subscription | opencode-go | gpt-5-nano | [executor,reviewer] | +`fast` | false | **yes** — add `fast` tag (desc says fast, tag absent). |
| 23 | oc-hy3-preview | subscription | opencode-go | hy3-preview-free | [executor] | — | false | **no** |
| 24 | oc-minimax-flash | subscription | opencode-go | minimax-m2.5-free | [executor,reviewer] | — | false | **no** |
| 25 | oc-ling-flash | subscription | opencode-go | ling-2.6-flash-free | [executor] | — | false | **no** |
| 26 | oc-nemotron-super | subscription | opencode-go | nemotron-3-super-free | [planner,reviewer] | — | **true** | **yes** — free-tier reasoner; make maestro_capable=true (parity + balance). Becomes the new `default_roles.reviewer` (§2). (Issue #7 — OD-3.) |
| 27 | oc-kimi-k2.6 | subscription | opencode-go | opencode-go/kimi-k2.6 | [reviewer,planner] | — | true | **no** |
| 28 | oc-deepseek-v4-pro | subscription | opencode-go | opencode-go/deepseek-v4-pro | [planner,reviewer] | — | true | **no** — CLI chat planner/reviewer (disambiguate from ACP sibling, #29). |
| 29 | oc-acp-deepseek-v4-pro | subscription | opencode-go | opencode-go/deepseek-v4-pro | [reviewer] | — | **true** | **yes** — same model as #28; ACP = file/terminal reviewer of record. Narrow to `[reviewer]`; set maestro_capable=true for parity with CLI sibling. (Issue #5.) |
| 30 | oc-deepseek-v4-flash | subscription | opencode-go | opencode-go/deepseek-v4-flash | [executor,reviewer] | — | false | **no** |
| 31 | oc-mimo-v2.5-pro | subscription | opencode-go | opencode-go/mimo-v2.5-pro | [planner,reviewer] | — | true | **no** |
| 32 | oc-minimax-m2.7 | subscription | opencode-go | opencode-go/minimax-m2.7 | [executor,reviewer] | — | false | **no** |
| 33 | oc-qwen3.6-plus | subscription | opencode-go | opencode-go/qwen3.6-plus | [executor,reviewer] | — | false | **no** |
| 34 | oc-glm-5.1 | subscription | opencode-go | opencode-go/glm-5.1 | [executor,reviewer] | — | false | **no** |

### Table 2 — API / pay-go agents (35 in live file; see §1.3)

| # | Agent | pricing_mode | provider | model (ideal) | roles (ideal) | tags (add) | maestro | CHANGE? |
|---|---|---|---|---|---|---|---|---|
| 35 | planner | api | local | granite41-8b | [planner] | — | false | **no** — default planner, free compute. |
| 36 | executor | api | local | granite41-8b | [executor] | — | false | **no** — default executor, free compute. |
| 37 | granite-mini | api | local | granite41-3b-q4 | [] | +`candidate` | false | **no** field; bench candidate, keep roles []. |
| 38 | granite-mini-3b | api | local | granite-4.1-3b-Q8_0 | [] | +`broken`,`swap-required` | false | **yes — QUARANTINE** — gateway :7843 returns 502, upstream Stopped; superseded by mac-mini-granite-3b-mlx-iso. Tag broken; keep roles []. |
| 39 | mac-mini-granite-3b-mlx-iso | api | local | granite-4.1-3b-4bit | [memory-refiner,dreaming-judge] | +`role-priority:primary` | false | **yes** — dual-holder; designate **PRIMARY** (it took the slot after the granite gateway broke and is the working path). (Issue #4, R9 — see OD-2.) |
| 40 | mac-mini-granite-8b-nvfp4-iso | api | local | granite-4.1-8b-nvfp4 | [] | — | false | **no** — reserve/bench. |
| 41 | mac-mini-qwen3-8b-mlx-iso | api | local | Qwen3-8B-MLX-4bit | [brief-synthesizer] | +`role-priority:fallback` | false | **yes** — brief-synthesizer FALLBACK behind local-qwen36-35b-a3b-mlx primary. |
| 42 | local-granite-3b-q8 | api | local | granite-4.1-3b-Q8_0 | [memory-refiner,dreaming-judge] | +`role-priority:fallback` | false | **yes** — dual-holder; designate **FALLBACK** (verify granite path before relying on it). (Issue #4 — OD-2.) |
| 43 | local-qwen36-35b-moe | api | local | local (35B-A3B) | [] | `avoid-for-reasoning`,`swap-required` | false | **no** field; keep []. |
| 44 | local-qwen36-27b | api | local | local | [] | `swap-required` | false | **no** |
| 45 | local-qwen36-35b-a3b-mlx | api | local | Qwen3.6-35B-A3B-4bit | [brief-synthesizer,dreaming-judge,memory-recall,task-refiner-rubric] | +`role-priority:primary` | false | **yes** — brief-synthesizer PRIMARY (priority hint only). |
| 46 | local-gemma4-26b-a4b-mtp | api | local | gemma4-26b-a4b-mtp | [] | `maestro-candidate`,`swap-required` | **false** | **yes** — maestro_capable currently true but endpoint not running + roles [] = dispatch trap. Set false until atomic fork is up. (R-trap.) |
| 47 | local-qwen35-27b | api | local | local (Q5_K_XL) | [] | `swap-required` | false | **no** field; 5/5 bench, could earn [reviewer] when served. |
| 48 | local-qwen3-coder | api | local | local | [] | `swap-required` | false | **no** |
| 49 | local-qwen35-4b | api | local | local | [] | `swap-required` | false | **no** |
| 50 | local-gemma31 | api | local | local (gemma-4-31B) | [] | `swap-required` | false | **no** |
| 51 | gemini-pro-direct | api | google | gemini-3.1-pro-preview | [] | `no-tools` | false | **no** — chat-only direct-HTTP; counts against google $25 billed rail + pro caps. |
| 52 | gemini-flash-direct | api | google | gemini-3-flash-preview | [] | `no-tools` | false | **no** field; 5/5, cheapest 5/5 (see OD-1: candidate default reviewer alternative). |
| 53 | nv-llama4-maverick | api | nvidia-nim | meta/llama-4-maverick-17b-128e | [] → [reviewer] after canary | +`tier:cheap` | false | **yes (staged)** — 5/5; promote to [reviewer] for T1 only after canary + rpm guard. (R1/R2.) |
| 54 | nv-qwen3-coder-480b | api | nvidia-nim | qwen/qwen3-coder-480b-a35b | [] → [reviewer] after canary | +`tier:cheap` | false | **yes (staged)** — 5/5, best near-free code reviewer; promote after canary. |
| 55 | nv-deepseek-v4-pro | api | nvidia-nim | deepseek-ai/deepseek-v4-pro | [] | +`disabled-free-tier` | false | **yes — QUARANTINE** — times out on free tier; deny-list from routing. (Issue #10, R3.) |
| 56 | nv-nemotron-super-49b | api | nvidia-nim | nvidia/llama-3.3-nemotron-super-49b-v1.5 | [] | +`avoid-structured-output` | false | **yes** — CoT leak; keep []; tag. |
| 57 | nv-llama-3.1-8b | api | nvidia-nim | meta/llama-3.1-8b-instruct | [] | +`fallback-only` | false | **no** field; 2/5 weak. |
| 58 | nv-glm-4-7 | api | nvidia-nim | z-ai/glm4.7 | [] | +`avoid-on-tight-budgets` | false | **yes** — 0/5 CoT leak; tag. |
| 59 | nv-minimax-m2-7 | api | nvidia-nim | minimaxai/minimax-m2.7 | [] | +`avoid` | false | **yes** — 0/5; tag. |
| 60 | nv-kimi-k2 | api | nvidia-nim | moonshotai/kimi-k2-instruct | [] | +`avoid-on-tight-budgets` | false | **yes** — 0/5; tag. |
| 61 | nv-deepseek-3-2 | api | nvidia-nim | deepseek-ai/deepseek-v3.2 | [] | +`avoid-on-tight-budgets` | false | **yes** — 0/5; tag. |
| 62 | nv-step-3-5-flash | api | nvidia-nim | stepfun-ai/step-3.5-flash | [] | — | false | **no** field; 0/5, keep []. |
| 63 | nv-deepseek-3-1-terminus | api | nvidia-nim | deepseek-ai/deepseek-v3.1-terminus | [] | +`avoid-on-tight-budgets` | false | **yes** — 0/5; tag. |
| 64 | groq-llama4-scout | api | groq | meta-llama/llama-4-scout-17b-16e | [] → [reviewer] after canary | +`tier:cheap` | false | **yes (staged)** — 5/5, ~600ms, smallest 5/5 cloud; promote after canary. |
| 65 | groq-llama-3.3-70b | api | groq | llama-3.3-70b-versatile | [] → [reviewer] after canary | — | false | **yes (staged)** — 4/5; candidate reviewer overflow. |
| 66 | groq-llama-3.1-8b | api | groq | llama-3.1-8b-instant | [] | +`fallback-only` | false | **no** field; ~2.5/5 weak. |
| 67 | groq-gpt-oss-120b | api | groq | openai/gpt-oss-120b | [] | +`avoid-on-tight-budgets` | false | **yes** — reasoning model, needs 4096 budget; tag. |
| 68 | groq-qwen3-32b | api | groq | qwen/qwen3-32b | [] | +`disabled-free-tier` | false | **yes — QUARANTINE** — 0/5, Groq rejects enable_thinking → raw `<think>` leakage; deny-list. (Issue #10, R3.) |
| 69 | gemini-flash-direct (counted above) | — | — | — | — | — | — | — |

*(Note: the lens analyses numbered the API set slightly differently; the canonical agent IDs above are authoritative. Local = 16 agents, NIM = 11, Groq = 5, Google-direct = 2.)*

### 1.1 Net classification deltas
- **1 retire** (codex-acp-gpt-5.4) + **3 quarantine** (granite-mini-3b broken, nv-deepseek-v4-pro free-tier broken, groq-qwen3-32b broken).
- **Role/maestro fixes (8):** claude-acp-sonnet (recall+explicit reviewer), claude-acp-haiku ([executor]+recall), codex-acp ([executor]-only), codex-acp-spark ([implementer]→[executor]), oc-big-pickle (maestro), oc-nemotron-super (maestro), oc-acp-deepseek-v4-pro (maestro+[reviewer]), local-gemma4-26b-a4b-mtp (maestro→false).
- **Description fix (1):** gemini-acp-flash.
- **Primary/fallback designations (2 role pairs):** memory-refiner/dreaming-judge, brief-synthesizer.
- **recall_context added to 2** Anthropic ACP agents.
- **~4 API agents promoted (staged, canary-gated)** to [reviewer] for load-spread: nv-llama4-maverick, nv-qwen3-coder-480b, groq-llama4-scout, groq-llama-3.3-70b.
- **Cost-bound + cron corrections** on the 3 long-lived Anthropic agents (§4).

### 1.2 Lens conflict reconciled — task-refiner `initial_agent`
The classification lens flagged `initial_agent: claude-acp-fast` as a "dangling reference to a non-existent agent." This is **incorrect** — `claude-acp-fast` was confused with `codex-acp-fast`. There is no `claude-acp-fast` in the fleet; the refiners point at... (verify before acting). **Resolution:** lines 1691 and 1829 both read `initial_agent: claude-acp-fast`. There is no agent with id `claude-acp-fast` (the cheap Anthropic ACP agent is `claude-acp-haiku`). This **is** a dangling ref. Repoint both to `claude-acp-haiku` (the actual cheap Anthropic ACP agent), or remove the field if the long-lived runner ignores it. Tagged as **OD-4** for sign-off since it touches live long-lived agents.

### 1.3 Count reconciliation (Issue underlying "69 total")
The audited brief says "31 subscription / 38 api = 69." The live file's OpenCode block carries **14** agents (6 free + 8 paid), making subscription = **33**, and API = **35** (16 local + 11 NIM + 5 Groq + 2 google-direct, minus the 1 duplicate count line) — still 69 total but split 33/36 vs the audited 31/38. **Decide the canonical set** (OD-5): keep all 14 OC agents (recommended — free compute spreads load) and update the audit to 33/36, or trim the paid OC tail if the billing pool is unfunded.

---

## 2. Usage-balancing / routing scheme

### 2.1 Updated `default_roles` (free-first fallback)
Today (lines 1940–1943): `planner=planner` (local), `executor=executor` (local), `reviewer=gemini` (gemini-3.1-pro-preview — the **tightest** quota in the fleet, pro 250K/24h + 50K/5h). `default_roles` is the fallback when no task-type route fires; the fallback must land on free compute, not the scarcest paid resource.

```yaml
default_roles:
  planner: planner             # local llamactl — keep (free compute)
  executor: executor           # local llamactl — keep (free compute)
  reviewer: oc-nemotron-super  # was: gemini. Move default OFF the pro quota onto a free-tier reasoner.
```

Rationale: `oc-nemotron-super` is a free-tier OpenCode reasoner already tagged `[planner, reviewer]`. Reserve gemini-pro and the codex/claude reviewers for task-types that *ask* for adversarial depth (§2.2/§2.3). With `unsampled-first`, broadened role lists mean the default rarely decides anyway — but when it does, it should be free. (Alternative: `gemini-flash-direct`, the cheapest 5/5 — see OD-1.)

### 2.2 Revised `review_personas.preferred_agent` (8 personas across 6 agents, was concentrated on 3)
Today both fan-outs concentrate on **codex-acp-deep** (architect, security, maintainability, data_correctness = 4) and **claude-acp-sonnet** (performance, devils_advocate, naming_clarity + both synthesizers). A single `/adversarial-review` is the most expensive recurring operation in the fleet — it fans 4 personas onto the priciest unmetered OpenAI tier (gpt-5.5 high) plus synthesis onto the priciest Anthropic tier. Keep the hardest lenses on premium; spread the soft/structured lenses onto the idle verified/paid pool.

| persona | today | proposed `preferred_agent` | why |
|---|---|---|---|
| architect | codex-acp-deep | **codex-acp-deep** | keep — deepest reasoner for layering/seams |
| security | codex-acp-deep | **codex-acp-deep** | keep — adversarial security needs the strongest tier |
| data_correctness | codex-acp-deep | **codex-acp-deep** | keep — boundary/invariant rigor is its strength |
| maintainability | codex-acp-deep | **gemini-acp-pro** | offload to the verified-working workhorse; spreads off OpenAI |
| performance | claude-acp-sonnet | **codex-acp-spark** | perf is pattern-matchy; fast strong model suffices |
| devils_advocate | claude-acp-sonnet | **claude-acp-sonnet** | keep — contrarian framing is a Claude strength |
| naming_clarity | claude-acp-sonnet | **oc-mimo-v2.5-pro** | low-stakes lens; spread to paid OC reasoner |
| simplicity | codex-acp-fast | **codex-acp-fast** | keep — fast/cheap fits the YAGNI lens |
| **review_synthesizer** | claude-acp-sonnet | **claude-acp-sonnet** | keep — long-gen synthesis, its proven strength |

Net: codex-acp-deep 4→3 (keeps the three hardest adversarial lenses), claude-acp-sonnet 3→1 (+synth). Three previously-idle agents (gemini-acp-pro, codex-acp-spark, oc-mimo-v2.5-pro) each pick up a lens. The economist lens argued for moving simplicity/naming/perf to near-free NIM/Groq (nv-qwen3-coder-480b, groq-llama4-scout are 5/5); the risk lens warns that **persona fan-out is parallel** and API agents have no rpm guard — so persona assignments stay on subscription/paid for now, and the near-free agents enter via single-dispatch review (T1/T2 escalation, §2.4) after canary. (Reconciled: OD-6.)

### 2.3 Revised `planner_personas.preferred_agent` (5 personas across 4 agents, was 3)
| persona | today | proposed | why |
|---|---|---|---|
| architect | claude-acp-sonnet | **claude-acp-sonnet** | keep — systems framing |
| test-first | claude-acp-sonnet | **gemini-acp-pro** | offload to verified workhorse; TDD shape is structured |
| simplifier | codex-acp-fast | **codex-acp-fast** | keep |
| risk | codex-acp-deep | **codex-acp-deep** | keep — failure-mode depth |
| integration | codex-acp-deep | **oc-deepseek-v4-pro** | spread plumbing lens onto paid OC reasoner |
| **plan_synthesizer** | claude-acp-sonnet | **claude-acp-sonnet** | keep — merge quality matters most |

Hard lenses (architect, risk, both synthesizers) stay premium; soft/structured lenses spread to the idle verified/paid pool.

### 2.4 Task-type → tier routing policy (5 tiers, cheapest-first)
Within a tier, spread by the rule in §2.5. The escalation ladder (one tier up per FAIL round, capped at 2 rounds per `dispatch-quality-gates`) keeps the bulk of work on free tiers; only genuinely hard or twice-failed work reaches premium.

- **Tier 0 — FREE LOCAL (llamactl; ~$0 marginal, VRAM/wall-time bound, only ~2–3 concurrent on the single :8080 GPU + always-on iso ports):** executor, planner, local-qwen3-coder, local-qwen36-35b-a3b-mlx, mac-mini-qwen3-8b-mlx-iso, granite-mini, local-gemma31, local-granite-3b-q8.
- **Tier 1 — FREE CLOUD (NIM ~40rpm shared / 1024-tok; Groq; OC free-tier). Single-dispatch only until an rpm guard exists.** NIM: nv-qwen3-coder-480b, nv-llama4-maverick, nv-nemotron-super-49b (+ weaker ones as fallback). Groq: groq-llama4-scout, groq-llama-3.3-70b, groq-gpt-oss-120b. OC-free: oc-nemotron-super, oc-big-pickle, oc-gpt-5-nano, oc-minimax-flash, oc-ling-flash, oc-hy3-preview. **Excluded:** nv-deepseek-v4-pro, groq-qwen3-32b (`disabled-free-tier`).
- **Tier 2 — PAID CHEAP (metered, low $):** codex-acp-fast, codex-spark/codex-acp-spark, gemini-acp-flash (flash 1.5M/24h — the generous Google cap), oc-deepseek-v4-flash, oc-minimax-m2.7, oc-gpt-5-nano.
- **Tier 3 — PAID STRONG (OC paid reasoners — treat opencode-go as ONE pooled $-bucket, round-robin within, shed whole tier at opencode-go refuse):** oc-deepseek-v4-pro, oc-acp-deepseek-v4-pro, oc-mimo-v2.5-pro, oc-kimi-k2.6, oc-qwen3.6-plus, oc-glm-5.1, gemini-acp-pro.
- **Tier 4 — PREMIUM SUBSCRIPTION (scarcest quotas; reserve for hard/twice-failed work):** claude-acp-sonnet, codex-acp, codex-acp-deep, codex. gemini-acp-pro (pro 50K/5h) is the lowest priority inside any tier it appears in — sheds first.

| task-type | tier | preferred agents (spread set) | cap to respect |
|---|---|---|---|
| health_check, smoke_test, lint_fix | T0 | executor, local-qwen3-coder, granite-mini | none (free) |
| docs_mechanical, comment/rename, format | T0→T1 | local first, overflow OC-free/Groq | none |
| memory-refiner, dreaming-judge | T0 | mac-mini-granite-3b-mlx-iso (primary), local-granite-3b-q8 (fallback) — §2.6 | none |
| brief-synthesizer | T0 | local-qwen36-35b-a3b-mlx (primary), mac-mini-qwen3-8b-mlx-iso (fallback) | none |
| classify/extract/json, summarize | T1 | NIM round-robin (1024-tok fits), Groq overflow | NIM ≤40rpm, single-dispatch |
| implement_small (1–2 files, has test) | T2 | codex-acp-fast, codex-acp-spark, gemini-acp-flash, oc-deepseek-v4-flash | flash 1.5M/24h |
| implement_medium | T2→T3 | T2 set, escalate to oc-deepseek-v4-pro / oc-mimo on FAIL | opencode-go pool |
| implement_substantial | T4 | codex-acp, claude-acp-sonnet, codex-acp-deep | Anthropic/OpenAI pressure caps |
| review_standard | T1→T3 | codex-acp-fast, OC reasoners; near-free NIM/Groq single-dispatch after canary | — |
| review_adversarial (`/adversarial-review`) | T4 personas | per §2.2 (6 agents) | pressure caps; gemini-pro sheds first |
| plan_refine (`/adversarial-plan`) | T4 personas | per §2.3 (4 agents) | — |
| plan_simple | T1→T3 | oc-nemotron-super, oc-big-pickle (free) → OC paid | — |
| long_lived_tick (home-mgmt, refiners) | T4-haiku | claude-acp-haiku tier — fix cost bound §4 | per-tick cost_cents |

**Recommended steady-state dispatch mix:** Local/FREE ~35% · NIM+Groq near-free ~20% · OpenAI ~18% · Google-flash ~12% · Anthropic ~10% · OpenCode ~5%. Subscriptions carry only the high-value/BOUNDARY tail.

### 2.5 Within-tier load-spread rule (config-only, no code change)
**(a) Role-list breadth + `unsampled-first`.** Adding an agent to a role's `roles[]` makes it role-eligible; `chooseSingle` (default `unsampled-first`) rotates unsampled agents in before settling on the ranked best. So membership IS the spread lever — widen a role across a tier and the router naturally round-robins cold agents, then prefers proven winners. **Critical safety coupling:** before broadening eligibility, the broken/untested set must be deny-listed AND `exploration_policy` flipped to `ranked-first` for any role that includes unproven agents (§3 Phase 2) — otherwise `unsampled-first` preferentially picks the failing agents.

**(b) Per-agent caps at the edges.** The binary ≥90% `isOverPressure` shed removes a provider near its cap. Per-agent caps (§4) let an individual agent self-eject before its provider-wide cap — e.g. gemini-acp-pro with a 5h budget reflecting 50K/5h sheds out of Tier 3/4 rotation before the whole google provider trips. Treat the opencode-go pool as one bucket: round-robin within, shed the whole Tier-3 OC set at opencode-go refuse.

**(c) Free local is the sink.** Load-spreading must push routine work to the 16 free local agents, NOT toward other subscription agents (which trips a different cap → `subscription_pressure_capped` defer/stall) and NOT toward unmetered API pay-go in parallel fan-out (no rpm guard → 429 storm).

True remaining-quota *weighting* (probabilistic pick ∝ headroom) is not in code — see §3 Phase 7 for the optional ~15-line change.

### 2.6 Memory/dreaming dual-holder resolution
`mac-mini-granite-3b-mlx-iso` and `local-granite-3b-q8` both hold `[memory-refiner, dreaming-judge]` with no priority. The session note says mac-mini took the slot after the granite-mini gateway path broke — mac-mini is the **working** path. **Resolution: mac-mini-granite-3b-mlx-iso = PRIMARY, local-granite-3b-q8 = FALLBACK** (the balancing/risk lenses and the working-path note agree). The classification lens proposed the reverse; reconciled in favor of the working path. Encode via a `role-priority:` tag or ordering. **Do not re-enable the granite path as live fallback until the gateway is verified** (R9). Flagged **OD-2**.

---

## 3. Concrete agentchat.yaml deltas (grouped, additive, reversible)

> All edits below are **routing-side** (roles, tags, maestro_capable, default_roles, personas, bounds) and hot-reload via `daemon_reload_config`. **No `adapter`/`options.model`/`options.args`/`binary` edits** are proposed — those would require a worker restart (R4) and none are needed here (the gemini-acp-flash fix is to the *description* only). Reload is **atomic**: one bad reference 422s the entire config, so grep every agent name across `default_roles`, all `preferred_agent`, `review_synthesizer`, `plan_synthesizer`, and `shell.per_agent_overrides` before any rename/delete (R8).

### 3.1 default_roles (lines 1940–1943)
```yaml
default_roles:
  planner: planner
  executor: executor
  reviewer: oc-nemotron-super   # was: gemini
```
Rollback: restore `reviewer: gemini`; reload.

### 3.2 codex-acp-spark roles (line 1298)
```yaml
    roles: [executor]   # was: [implementer] (non-routable role string)
```
Rollback: restore `[implementer]`.

### 3.3 gemini-acp-flash description (line 1008)
Change `(gemini-2.5-flash)` → `(gemini-3-flash-preview)` to match args (line 1011). Cosmetic/safe; never align args toward 2.5 (it 429s). Rollback: restore prior string.

### 3.4 codex-acp-gpt-5.4 — quarantine first, delete later
```yaml
    maestro_capable: false              # was: true (phantom maestro slot)
    tags: [..., deprecated-do-not-route]
```
Phase the deletion of the block after a transition window. Rollback: set `maestro_capable: true`.

### 3.5 Role/maestro corrections
- claude-acp-sonnet: `roles: [reviewer]` (explicit) + add `recall_context: { enabled: true, k: 3, scope: global, max_chars_per_result: 800 }`.
- claude-acp-haiku: `roles: [executor]` + same `recall_context` block.
- codex-acp: `roles: [executor]` (drop reviewer).
- oc-big-pickle: `maestro_capable: true`.
- oc-nemotron-super: `maestro_capable: true`.
- oc-acp-deepseek-v4-pro: `roles: [reviewer]` + `maestro_capable: true`.
- local-gemma4-26b-a4b-mtp: `maestro_capable: false` (endpoint down).
Rollback per agent: restore prior `roles`/`maestro_capable`/remove `recall_context`.

### 3.6 Quarantine tags (deny from routing)
- granite-mini-3b: `tags: [..., broken, swap-required]`, roles stay `[]`.
- nv-deepseek-v4-pro: `tags: [..., disabled-free-tier]`, roles `[]`.
- groq-qwen3-32b: `tags: [..., disabled-free-tier]`, roles `[]`.
- codex-frontier, codex-mini, gemini-flash: `tags: [..., untested-hold]`, roles `[]`.
Plus, if the schema/router supports it, add these IDs to per-role `deny_agents`. Rollback: remove tags / deny entries.

### 3.7 Primary/fallback priority hints
- mac-mini-granite-3b-mlx-iso: `tags: [..., role-priority:primary]`.
- local-granite-3b-q8: `tags: [..., role-priority:fallback]`.
- local-qwen36-35b-a3b-mlx: `tags: [..., role-priority:primary]` (brief-synthesizer).
- mac-mini-qwen3-8b-mlx-iso: `tags: [..., role-priority:fallback]` (brief-synthesizer).
Rollback: remove the tags.

### 3.8 Persona preferred_agent edits (lines ~2030–2235)
Apply the §2.2/§2.3 tables: maintainability→gemini-acp-pro, performance→codex-acp-spark, naming_clarity→oc-mimo-v2.5-pro; planner test-first→gemini-acp-pro, integration→oc-deepseek-v4-pro. Synthesizers unchanged (claude-acp-sonnet). Rollback: restore each prior `preferred_agent`.

### 3.9 Staged API-agent role promotions (Phase 5 only, after canary)
- nv-qwen3-coder-480b, nv-llama4-maverick, groq-llama4-scout, groq-llama-3.3-70b: `roles: [reviewer]`.
Apply ONLY after Phase 2 deny-list + `exploration_policy: ranked-first` + Phase 4 canary. Rollback: restore `roles: []`.

### 3.10 exploration_policy guard (role_routing)
```yaml
role_routing:
  exploration_policy: ranked-first   # was/default: unsampled-first
```
Apply before any role broadening (§3.9) so the router cannot blind-pick unproven agents. Rollback: restore `unsampled-first`. (See OD-7.)

---

## 4. Cost / limit corrections

### 4.1 home-mgmt cost bound (P0 — real money on the Anthropic plan)
- **Current:** `*/10` cron (144 ticks/day), and per the live file (line ~1648) **no `bounds.cost_cents` on home-mgmt at all** — the "50¢/tick" figure in the audit refers to the *escalation* refiner; home-mgmt currently has no per-tick cap. Either way the exposure is unbounded daily.
- **Stale comment:** the inline note implies the `*/10` cadence was sized for "gemma's 4-min floor," but home-mgmt now runs cloud Haiku — the comment is stale.
- **Fix:** add `bounds.cost_cents: 2–3` (a Haiku short-circuit tick is well under 1¢) and/or widen `*/10` → `*/30`. At cost_cents 3 × 48 ticks/day (`*/30`) the worst-case ceiling is ~$1.44/day, aligned with the "<$1/day" intent.
- Rollback: remove `cost_cents` / restore `*/10`; verify the next tick still runs.

### 4.2 task-refiner per-tick caps
- task-refiner-primary: `cost_cents: 20` × `*/15` = 96 ticks/day = **$19.20/day** worst-case ceiling on the Anthropic plan.
- task-refiner-escalation: `cost_cents: 50` × 96 = **$48/day** ceiling.
- Combined long-lived Anthropic worst-case ≈ **$67–139/day** depending on home-mgmt — far above the $50/24h display quota (which doesn't gate them, since synth ≠ billed).
- **Fix:** lower per-tick cost_cents to match the Haiku short-circuit reality (≈1–2¢ on a no-anomaly tick); widen escalation cron if its queue is usually empty. Add a **long-lived daily aggregate cost cap** across all three (none exists today — only per-tick caps).
- Rollback: restore prior cost_cents; verify next tick.

### 4.3 gemini-acp-pro per-agent 5h cap
Add a per-agent token budget reflecting the pro **50K/5h** ceiling so it self-sheds out of Tier 3/4 before the whole google provider trips. This is the tightest real limit in the fleet and pro is the workhorse → frequent refuses are likely without it.

### 4.4 Unmetered-provider stopgap (P0 — OpenAI + OpenCode-Go)
The two largest subscription pools (9 OpenAI, 14 OpenCode) have **no `pressure_caps` block** → never refused. Until a live pressure feed is wired (code follow-up), add a **synthetic per-provider dispatch-count / concurrency cap** as a stopgap so a fan-out cannot drain either plan unbounded. Flagged **OD-8** (requires either config support or a small code change).

### 4.5 Surface billed-vs-synth in cost_quota_status (P3)
Make `cost_quota_status` output show that the $50/$25/$10 USD quotas do NOT gate subscription agents (pressure caps do). Prevents false confidence in the USD ceilings. Code follow-up, not a config edit.

---

## 5. Retirement / quarantine list

| Agent | State | Recommended action | Rationale |
|---|---|---|---|
| codex-acp-gpt-5.4 | deprecated, maestro_capable+no-roles | `maestro_capable: false` now (reversible); delete block after transition window | Phantom maestro slot the router can pick; superseded by codex-acp. |
| granite-mini-3b | broken (gateway :7843 → 502, upstream Stopped) | Tag `broken`, keep roles `[]`; superseded by mac-mini-granite-3b-mlx-iso | Non-functional local; keep block for provenance. |
| nv-deepseek-v4-pro | broken on free tier (times out) | Tag `disabled-free-tier` + deny-list; re-enable only on a paid NIM tier | Correctly classified but non-functional; never grant roles. |
| groq-qwen3-32b | broken (Groq rejects enable_thinking → raw `<think>`) | Tag `disabled-free-tier` + deny-list | 0/5 bench; structural provider incompatibility. |
| codex-frontier | untested (bench-2) | Tag `untested-hold`, roles `[]`; bench via deliberate canary, not blind exploration | Untested ≠ eligible (R2). |
| codex-mini | untested | Tag `untested-hold`, roles `[]` | As above. |
| gemini-flash | untested | Tag `untested-hold`, roles `[]` | As above. |
| local-gemma4-26b-a4b-mtp | maestro slot with endpoint down | `maestro_capable: false` until atomic fork is up | A maestro slot whose endpoint isn't running is a dispatch trap. |

Principle: "correct semantics" ≠ "eligible." Broken/untested agents stay in config for provenance with `roles: []` and/or `deny_agents`; they earn eligibility via deliberate canary samples, never via `unsampled-first` blind exploration on real tasks.

---

## 6. Safe rollout & rollback

Every phase is a yaml diff over a timestamped backup; rollback = restore backup + `daemon_reload_config` (routing-side) or restore + worker restart (worker-side). No phase deletes an agent block until all references are confirmed dropped.

- **Phase 0 — Snapshot & invariant.** Back up live yaml (`*.bak-pre-rebalance-2026-06-02`). Capture current `agent_route_for` outputs for planner/executor/reviewer as the regression baseline. **Dry-parse** the edited yaml against the config schema before writing (atomic reload 422s on any bad ref).
- **Phase 1 — Pure-metadata corrections (hot, zero routing change).** §3.2 (codex-acp-spark role string), §3.3 (gemini-acp-flash description), §3.4 (codex-acp-gpt-5.4 maestro=false), §3.7 (priority tags). Verify `daemon_reload_config` returns ok with expected agent_count. Rollback: restore .bak; reload.
- **Phase 2 — Deny/guard the broken+untested set (gate before any broadening).** §3.6 quarantine tags/deny, §3.10 `exploration_policy: ranked-first`. This is the gate that makes Phase 5 safe (R2/R3).
- **Phase 3 — Shadow the rebalanced routing.** Use `agent_route_for` (`detail: rank`) on real task types to see what the new role membership + default_roles WOULD select, without dispatching. Confirm load moves toward free local (R6), not API pay-go (R1) or other subscriptions.
- **Phase 4 — Canary newly-eligible agents.** Deliberately dispatch ~3 low-stakes tasks each to nv-qwen3-coder-480b, nv-llama4-maverick, groq-llama4-scout, groq-llama-3.3-70b to seed `agent_performance` under controlled conditions. Only agents that clear canary proceed.
- **Phase 5 — Flip role membership for proven agents only; widen gradually.** §3.5 role/maestro corrections, §3.1 default_roles, §3.8 personas, §3.9 staged API promotions. Monitor 429 clustering (`cost_recent`/`dispatch_audit`) and `subscription_pressure_capped` defers after each widening.
- **Phase 6 — Cost-bound corrections.** §4.1/§4.2/§4.3 in their own step; verify the next long-lived tick still runs; keep old values noted for rollback (R10 — lowering cost_cents can hard-stop a long-lived agent mid-tick).
- **Phase 7 (optional, deferred code follow-ups).** Headroom multiplier in `agent-routing.ts` (~15 LOC: multiply quality `score` by `1 − used_pct` from the pressure snapshot already in scope at line ~498) for true quota-weighted spread; per-provider pressure feed / synthetic concurrency cap for OpenAI + OpenCode-Go; per-agent rpm field in the schema for NIM/Groq parallel safety; billed-vs-synth surfacing in `cost_quota_status`. **All explicitly out of scope for the config rebalance.**

**Hard fences (do not touch):** promotion/near-dup dreaming gates (env-gated default-off — leave unset, do not bundle env changes); silent-failure-retry logic + `reliability_status` taxonomy; worker-side `adapter`/`model`/`args`/`binary` (restart-gated, none proposed); the two dual-holder memory/dreaming assignments beyond adding the priority tag, until the granite gateway is verified.

---

## 7. Open decisions for sign-off

- **OD-1 — Default reviewer target.** Recommend `oc-nemotron-super` (free-tier reasoner, already [planner,reviewer]). Alternative: `gemini-flash-direct` (cheapest 5/5, but chat-only/no-tools). **Default: oc-nemotron-super.**
- **OD-2 — Memory/dreaming primary.** Recommend `mac-mini-granite-3b-mlx-iso` = primary (the working path post-gateway-break), `local-granite-3b-q8` = fallback, granite path verified before relying on it. **Default: mac-mini primary.**
- **OD-3 — OpenCode free-tier maestro parity.** Recommend setting `oc-big-pickle` + `oc-nemotron-super` `maestro_capable: true` (free compute, balances load off the paid OC pool). Alternative (risk-lens view): leave maestro off and treat it as an earned flag. **Default: enable, but only after canary confirms they sustain a maestro session.**
- **OD-4 — task-refiner `initial_agent`.** `initial_agent: claude-acp-fast` (lines 1691, 1829) references a non-existent agent. Recommend repointing both to `claude-acp-haiku`. **Default: repoint to claude-acp-haiku** (verify the long-lived runner honors the field; if it ignores it, remove the field instead).
- **OD-5 — Canonical fleet count.** Audit says 31/38; live file is 33/36 (14 OC agents present). Recommend keeping all 14 OC agents (free compute spreads load) and updating the audit to 33/36. Alternative: trim the paid OC tail if billing is unfunded. **Default: keep 14, update audit.**
- **OD-6 — Near-free agents in persona fan-out.** Economist wants simplicity/naming/perf personas on near-free NIM/Groq (5/5, ~$0); risk warns persona fan-out is parallel and API agents have no rpm guard. Recommend keeping personas on subscription/paid for now and routing near-free agents via single-dispatch T1/T2 review only, until a per-agent rpm cap ships. **Default: personas stay subscription/paid; near-free enters via single-dispatch.**
- **OD-7 — exploration_policy.** Recommend `ranked-first` for roles that include any unproven agent (prevents `unsampled-first` from blind-picking them). Alternative: keep `unsampled-first` but rely entirely on deny-lists. **Default: ranked-first during the rollout, revisit once the broken set is deny-listed and the new agents are sampled.**
- **OD-8 — Unmetered-provider stopgap.** OpenAI + OpenCode-Go cannot be refused today. Recommend a synthetic per-provider dispatch-count/concurrency cap as a stopgap pending a real pressure feed (small code change). **Default: add the stopgap; schedule the pressure-feed follow-up.**

---

*Files of record:* live config `/Users/acordeiro/.config/agentchat/agentchat.yaml` (default_roles L1940–1943, providers L1945+, review_personas L2030–2135, synthesizers L2136+/L2218+, codex-acp-spark role L1298, gemini-acp-flash desc L1008/args L1011, refiner initial_agent L1691/L1829, home-mgmt L1648). Routing engine `packages/core/src/services/agent-routing.ts` (scoring, pressure shed `isOverPressure` ≥0.9, exploration policy). Pressure cap `packages/core/src/maestro/check-pressure-cap.ts`. Config schema (no rpm field) `packages/agentchat/src/config/types.ts`. Cost accounting `packages/core/src/readers/cost-quota.ts`, `cost.ts`. Reload gap `packages/daemon/src/routes/reload-config.ts`. Fences: `packages/core/src/writers/t2.ts` (promotion gates), `packages/agentchat/src/worker/silent-failure-retry.ts`.
