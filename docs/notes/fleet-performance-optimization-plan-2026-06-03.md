This is a synthesis task — merge five persona plans into one prioritized plan. The inputs are all provided in the assignment. I don't need to run tools; I have the profiling findings, five persona plans, and confirmed telemetry. Let me produce the merged Markdown plan directly.

# Penumbra Fleet — Performance Optimization Plan (Synthesized)

This plan merges five persona analyses (architect / latency-routing / local-utilization / token-context / throughput-measurement) into one impact-ranked, phased roadmap. Scope: **performance only**. Stability (ACP stdin-fatal / worker crashes) is owned by a parallel track; every phase below is annotated for stability interaction and none of the high-confidence early phases touch the subprocess/ACP lifecycle.

---

## 1. Bottleneck Ranking (biggest lever first)

| # | Bottleneck | Quantified impact (24h volume ≈ 2,870 handoffs, ~2 dispatches/min) | Conf. |
|---|---|---|---|
| **B1** | **Per-dispatch ACP cold-start, no warm pool.** Every stdio-acp dispatch spawns a fresh CLI subprocess + full `initialize`/`authenticate`/`session/new` (re-loading MCP tool schemas) then `server.kill()`s it (`stdio-acp.ts:894`). Re-paid on every mid-dispatch retry (handoff 562c7138 showed `acp.server.start=2`). | Framework floor **1.9s warm → 134.5s cold** per dispatch (verified handoffs 562c7138 @1.9s, 4f1776a9 @29.9s spawn + 104.6s handshake). At a conservative 30s mean cold-start saved × 2,870 dispatches ≈ **~24 worker-hours/day reclaimed**; worst-case 135s floor exceeds codex-acp-fast's *entire* 197s mean latency. | high |
| **B2** | **Routing scorer is latency-blind.** `scoreCandidate` (`agent-routing.ts:273-303`) weights outcome/rounds/smoke/reviewer/maestro(/cost) only. `avg_latency_ms` is computed (`:246`) and surfaced (`:423`) but **carries zero weight**; `buildRank` sort (`:431-436`) and `pickPreferred` (`auction.ts:19`) never tiebreak on it either. | 8.3× latency spread (codex-acp-fast 196,954ms vs claude-acp-sonnet 1,640,705ms) collapses to a **0.077–0.098 score gap**. A latency term shifts the *auction* share off the slow tier (codex-acp-deep 580k, gemini-acp-pro 1.06M) toward codex-acp-fast (197k) / oc-mimo (304k) at equal-or-better success → **~6–14 min wall-clock saved per redirected substantial dispatch**. | high |
| **B3** | **claude-acp-sonnet hard-pinned via `preferred_agent`, bypassing the scorer.** It is `roles:[reviewer]` (`agentchat.yaml:1366`) so it is **not** an auction candidate. Its 55 implement_substantial samples come from `preferred_agent` pins in review_synthesizer (`:2145`), plan_synthesizer (`:2224`), devils_advocate (`:2091`), architect persona (`:2168`). **A scorer latency term does NOT touch this traffic.** | claude-acp-sonnet is the **only high-volume coder with non-null cost: $2.17/success, 38.2% success, 1.64M ms avg**. 34 of 55 dispatches fail, still burning Anthropic plan + wall-clock. Config repoint is the **only** lever here. | high |
| **B4** | **No fast local coder in any role pool; local capacity near-dead.** Executor role has only granite-8b (local) + remote; Qwen3-Coder-30B (67 tps, composite 0.925) is undeployed; granite-8b is `Failed PortCollision` so :7944 serves the **3B**, not the 8B. Task-size classification is **post-hoc** (`ledger-bridge.ts:14-20`, `agent-performance.ts:263-272`) — `inferAgentTaskTypeForRole` emits only 3 task types and never reaches the router, so **100% of executor work pays implement_substantial routing**. | Qwen3-Coder-30B local (~5–15s) replacing a 197k–1.64M ms remote dispatch on trivial work is an **order-of-magnitude latency cut at zero marginal cost** — but only realizable once both a local coder is deployed AND dispatch-time size routing exists. | high |
| **B5** | **Latency measurement is queue-inflated.** `captureAgentPerformanceFromDispatch` computes `latency_ms` from enqueue ts → `resolved_at` (`agent-performance-capture.ts:55-61,237,280`), folding **queue-wait** into the number. Real exec time (`wall_ms`, `dispatcher.ts:434`) is emitted in `dispatch.end` meta but discarded. | Distorts **every** latency number B2/B4 would consume; under load the inflation is unbounded. This is the **correctness prerequisite** for any weighted latency routing — a naive term on `latency_ms` feeds scheduling load back into routing. | high |
| **B6** | **MCP tool results ship raw into the maestro opus context.** Token-opt envelope is opt-in (`if (input.envelope)`, `fs-grep.ts:86`) and wired into ~15/131 tools; the maestro never passes `envelope:true`. `memory_recall` (`recall.ts:42`) has **no envelope and no body cap** — selects full `m.body` (`core/readers/recall.ts:208`). | Measured raw single-result sizes: fs_grep **50,784 B**, dispatch_timeline 36,259 B, memory_recall **41,697 B**, task_list 13,654 B. Maestro burns ~14,900 tok/turn (14.36M/967), and each oversized result is **re-sent every turn until compaction**. Central budget ≈ **0.3–1M opus tok/24h** trimmed + slower compaction. (Note: the 14.36M opus line is the **maestro orchestrator**, not a fleet agent — no opus traffic to reroute.) | medium |
| **B7** | **Anthropic cache hit-rate captured but surfaced nowhere.** `cache_read_input_tokens`/`cache_creation_input_tokens` are parsed (`claude-jsonl-reader.ts:89-92`) and forwarded (`poller.ts:154-155`) but **no cost route/tool reads them** — `cost_recent` reports only `tokens_used`. | Zero direct savings, but this is the **measurement prerequisite** to know whether the 14.4M opus sink (~89% of $) is 90% cached (fine) or 50% cached (a fixable preamble-instability bug). Anthropic spend is currently **tuned blind**. | high |
| **B8** | **No continuous perf signal; bench-acp can't survive a run.** No `/metrics`, no per-hour aggregation — perf is read only from the **month-stale** leaderboard. bench-acp holds results in memory and writes only at the end (`bench-acp.ts:94,113,148`) with no per-item timeout (`:54-60`), so one wedge loses 100% and stalls a slot. `dispatch_events` already stores `wall_ms`, ts-indexed, ~30d retention (`schema.ts:357-368`) — a reader needs **zero new instrumentation**. | Read-only aggregator unblocks every other phase from being "tuned blind." Zero stability risk. | high |

**Resolved disagreement — what actually reduces claude-acp-sonnet traffic.** Three personas flagged sonnet but two distinct mechanisms feed it, requiring two different fixes (latency-routing persona's key insight, adopted): the **auction path** (executor candidates) is fixed by B2 (scorer latency term); the **dominant 55-sample synthesizer/persona traffic** is fixed *only* by B3 (config repoint), because those dispatches **never call the scorer**. Any plan claiming "a latency term reduces sonnet usage" is wrong for the dominant share. Both levers are kept, scoped separately.

---

## 2. Restore Measurement FIRST (un-blind before tuning)

We are tuning blind on three axes; fix all three before the routing/pool changes that depend on them. None require new instrumentation — the data already exists.

1. **Continuous throughput/latency reader (P-Measure-A).** One SQL reader over `dispatch_events.dispatch.end` `wall_ms` → per-agent p50/p95 **execution** latency, dispatches/hour, and live queue depth (`COUNT handoffs WHERE status IN ('approved','redirected')`). Expose as one read-only MCP tool. Replaces the stale bench as the always-on signal and is the before/after instrument for every later phase. Zero behavior risk.
2. **Fix latency provenance (P-Measure-B = B5).** Add a nullable `exec_ms` column to `agent_performance`, populated from `dispatch.end` `wall_ms`; keep `latency_ms` untouched for back-compat. This is what the B2 weighted term must key on, *not* the queue-inflated `latency_ms`.
3. **Surface `cache_read_pct` (P-Measure-C = B7).** Add the already-forwarded `tokens_cache_read/write` to the `cost_recent`/`cost_quota_status` read path; report `cache_read / (cache_read + input)` per provider/model. Pure read-side.
4. **(Deferred, optional) Make bench-acp checkpoint-and-resume** + per-item deadline (`bench-acp.ts:54-60,94,148`), run per-agent slices via the existing CSV flag. Script-only, no prod path. **Note:** once P-Measure-A exists, the live `exec_ms` capture supersedes the bench for *latency* routing — the bench is only still needed for *capability/quality* leaderboard refresh, so it drops to LOW priority.

---

## 3. Phased Optimization Plan (ordered by impact ÷ effort)

Ordering follows the integration lens: cheapest reversible measurable wins on the highest-confidence bottlenecks first; the high-blast-radius warm pool last, only after measurement proves the win and can detect regressions.

### Phase 0 — Latency tiebreak in the auction/scoring path *(no flag, no new data)*
- **Goal:** Make agent selection latency-aware at the cheapest altitude — break score+success_rate ties by `avg_latency_ms ASC` in the same path the executor auction consumes (`buildRank` → `pickPreferred`), closing the gap where `buildRecommendations` already tiebreaks on latency (`agent-routing.ts:468`) but the auction path does not.
- **Metric / measure:** `agent_rank(implement_substantial)` candidate ORDER for score-equal pairs; an `agent_recommend`/`route_simulate` dry-run showing oc-mimo-v2.5-pro (304k, score 0.5975, only 5 samples) and codex-acp-fast rank above slower score-equal peers. Track 7-day share of dispatches on `>2× candidate-median latency` agents (P-Measure-A).
- **Change:** Insert `(a.avg_latency_ms ?? Infinity) − (b.avg_latency_ms ?? Infinity)` between the success_rate tiebreak and the name tiebreak in `buildRank`'s `.sort` (`agent-routing.ts:431-436`). Null latency sorts last.
- **Files:** `packages/core/src/services/agent-routing.ts`, `packages/core/src/tasks/auction.ts`.
- **Reversible:** Y. **Rollback:** revert one comparator line; no state/migration/config.
- **Risk:** Near-zero — only reorders candidates already tied on score AND success_rate, cannot promote lower quality. Does not touch ACP/subprocess lifecycle. Mild traffic shift toward codex-acp-fast/oc-mimo — flag to stability track as the early canary for the heavier Phase 2 shift.

### Phase 1 — Measurement foundation *(Section 2, items 1–3)*
- **Goal:** Un-blind: continuous exec-latency/throughput reader + load-independent `exec_ms` + `cache_read_pct`.
- **Metric / measure:** New MCP tool returns per-agent p50/p95 exec `wall_ms`, dispatches/hr, queue depth (cross-check p50 vs hand SQL for one agent). `AVG(latency_ms − exec_ms)` per agent quantifies how much of sonnet's 1.64M ms is queue vs run (answers a standing open question). `cache_read_pct` visible in `cost_recent`.
- **Change:** (a) SQL reader + one read-only MCP tool over `dispatch_events`; (b) additive nullable `exec_ms` column written from `dispatch.end` `wall_ms` (null fallback, never NaN); (c) surface `tokens_cache_read/write` in cost read path.
- **Files:** `packages/core/src/db/schema.ts`, `packages/core/src/services/agent-performance-capture.ts`, `packages/agentchat/src/worker/dispatcher.ts`, `packages/mcp/src/tools/dispatch-timeline.ts` (or a new reader tool), `packages/agentchat/src/usage-readers/poller.ts`.
- **Reversible:** Y. **Rollback:** drop the MCP tool registration; stop writing `exec_ms` (nullable column inert); ignore `cache_read_pct`.
- **Risk:** Zero behavior risk — purely additive reads/columns; no read path consumes `exec_ms` until Phase 2. Stability-neutral.

### Phase 2 — Weighted latency term in `scoreCandidate` *(flag-gated, keyed on `exec_ms`)*
- **Goal:** Shift real implement_substantial *auction* traffic off the slow tier toward codex-acp-fast / oc-mimo, keeping outcome dominant so latency breaks near-ties, never overrides quality.
- **Metric / measure:** Flag off vs on (canary): `route_simulate` over a fixed task set showing chosen-executor avg `exec_ms` drops; 7-day `agent_rank` showing further drop in the `>2×-median` share beyond Phase 0. Quantify reclaimed wall-clock = `Σ(old_share·old_exec − new_share·new_exec)` over 24h substantial volume. **Guardrail:** substantial success_rate must NOT regress.
- **Change:** Add `role_routing.latency_weighting` boolean to `RoleRoutingConfigSchema` (`config/types.ts`, default false). When on: `latency_score = clamp01((maxExec − exec_ms)/(maxExec − minExec))` over the candidate set (mirror cost normalization at `agent-routing.ts:383-387`; null → 0.5). Reweight e.g. **outcome 0.28 / rounds 0.18 / smoke 0.18 / reviewer 0.14 / maestro 0.07 / latency 0.15**. Gate the latency *reward* behind a **min success_rate floor** (so local-gemma 9.3k ms / 0% is never promoted) and **winsorize `exec_ms`** so one 27-min outlier doesn't dominate min/max. Compose after `headroom_weighting` (multiplicative quota factor).
- **Files:** `packages/core/src/services/agent-routing.ts`, `packages/agentchat/src/config/types.ts`, `~/.config/agentchat/agentchat.yaml`.
- **Reversible:** Y. **Rollback:** `latency_weighting:false` + `daemon_reload_config` (hot-reloads agentchat.yaml per landed 5cf0d210); main unchanged until explicitly enabled.
- **Risk:** Medium, **stability-coupled** — concentrates traffic on codex-acp-fast/oc-mimo. **MUST land after Phase 1** (consumes `exec_ms`, not queue-inflated `latency_ms`). Enable only after a canary watching codex/opencode ACP crash rates (P-Measure-A). Hard mitigations baked in: outcome weight ≥0.28, min-success floor, winsorized `exec_ms`.

### Phase 3 — Repoint synthesizer `preferred_agent` pins off claude-acp-sonnet *(config-only, B3)*
- **Goal:** Cut the dominant sonnet sink the scorer never sees — the only lever over that 55-sample traffic.
- **Metric / measure:** 7-day `agent_rank` + `cost_recent` showing claude-acp-sonnet implement_substantial sample count and $ falling, synthesizer-handoff avg `exec_ms` dropping toward the replacement. **Guard:** per-handoff `dispatch_audit` on review_synthesizer + plan_synthesizer handoffs to confirm **synthesis-specific** quality holds (sonnet's 38% is polluted by devils_advocate/architect persona dispatches — synthesis quality may be higher).
- **Change:** Repoint `preferred_agent` in review_synthesizer (`agentchat.yaml:2145`) and plan_synthesizer (`:2224`) off claude-acp-sonnet to a faster capable maestro agent (codex-acp-deep 580k ms, `maestro_capable`; or gemini-acp-pro 1.06M ms / 64% success). Keep personas (`:2091`,`:2168`) as-is initially to isolate the synthesizer effect.
- **Files:** `~/.config/agentchat/agentchat.yaml`.
- **Reversible:** Y. **Rollback:** restore original values + `daemon_reload_config`. Instant.
- **Risk:** Medium-quality, low-mechanism. No code, no transport change (stability-neutral). Real risk is trading synthesis quality for speed — mitigate by gating the persona repoint on the per-handoff synthesis-only success check; ship synthesizers-only first as a reversible canary.

### Phase 4 — Token/context relief: central MCP budget + `memory_recall` body cap *(B6)*
- **Goal:** Cap worst-case single-tool-result injection into the maestro opus context across all 131 tools at once (vs the stalled 15/131 per-tool migration), and cap the un-budgeted `memory_recall` body.
- **Metric / measure:** From the mcp-invocations log, post-change p99 `result_bytes` per tool (target: any single result capped at ~32KB with overflow spilled to `read_handle`; memory_recall body ≤ ~600 chars/hit). Pair with `cache_read_pct` (Phase 1) to attribute the opus token sink.
- **Change:** (a) Flag-gated central truncate-or-spill in `instrumentation.ts` (the universal wrapper already measures `result_bytes` at `:108`) behind `PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS` (default off): truncate via existing `budget.ts`, spill remainder to existing `HandleStore`, return `makeEnvelopeResult`; per-tool exempt-list, preserve `isEnvelopeResult`/`isMcpErrorEnvelope` shapes. (b) `body_max_chars` (default ~600) on `memory_recall` (`recall.ts`) matching the RecallEnricher cap; keep `memory_get_observations` as on-demand hydrate (the 3-layer pattern `memory_search` already uses, `registry.ts:446`).
- **Files:** `packages/mcp/src/instrumentation.ts`, `packages/mcp/src/responses/budget.ts`, `packages/mcp/src/handle-store.ts`, `packages/mcp/src/tools/recall.ts`.
- **Reversible:** Y. **Rollback:** unset the env flag (central budget off) / raise `body_max_chars`; both default to current raw behavior.
- **Risk:** Medium. Central budget could break a caller parsing exact raw JSON (workflow lifecycle scripts, `read_handle` round-trips) — mitigated by default-off flag + per-tool exempt-list + preserved envelope shapes. memory_recall cap could regress a caller relying on full inline bodies — mitigated by the on-demand hydrate path. Stability-neutral (read-shaping only).

### Phase 5 — Deploy a fast local coder + dispatch-time size routing *(B4)*
- **Goal:** Route trivial executor work (docs_mechanical / implement_small) to a warm local server at ~5–15s, zero marginal cost, instead of paying 197k–1.64M ms remote routing on 100% of executor work.
- **Metric / measure:** `llamactl_workload_list` / `:7944` curl confirming Qwen3-Coder-30B `Running`; P-Measure-A showing a new fast-local-coder agent taking a measurable share of size-classified small tasks at p50 ≪ remote; success_rate on those tasks ≥ floor.
- **Change:** (a) Deploy Qwen3-Coder-30B-A3B local workload (copy granite41-8b extraArgs: `-ngl 999`, flash-attn on, `-ub 2048`, q8_0 KV) on a free port (resolve the 8083/granite-8b `PortCollision` first); add an agent with `role: executor`. (b) Add dispatch-time size classification to `computeRouteForRole`/`inferAgentTaskTypeForRole` emitting `docs_mechanical`/`implement_small`; add `eligible_agents` pools in routing.yaml pointing at the fast local model. Flag-gated, with a min-success floor so a fast-but-failing local is never auto-selected (verify with `route_simulate`).
- **Files:** `packages/core/src/services/agent-performance.ts`, `packages/core/src/tasks/ledger-bridge.ts`, `packages/daemon/src/routes/agents.ts`, `config-penumbra/routing.yaml`, `workloads/Qwen3-Coder-30B-*.yaml`, `docs/notes/llamacpp-shared-ngram-cache-runbook-2026-05-14.md`.
- **Reversible:** Y. **Rollback:** remove the local agent / size-routing flag; executor work reverts to current routing. Destroy the workload.
- **Risk:** Medium. The local openai-compat-HTTP path **avoids** the stdio-acp adapter, so it sidesteps the wedge surface (a plus). Caveat: confirm the stability-track ACP-wedge fix doesn't assume a deployed local coder. Size misclassification could route a substantial task to a small model — gate behind a conservative classifier + min-success floor; keep substantial → remote default.

### Phase 6 — ACP warm pool for codex-acp-fast (pilot) *(B1 — highest raw impact, highest effort, last)*
- **Goal:** Remove the 1.9s–134.5s framework floor paid on every stdio-acp dispatch and re-paid on retries, by keeping the negotiated session alive across dispatches per `(agent, cwd)`, refcounted with idle-grace — mirroring the **existing** `mcp-pool.ts` pattern (refs Set + `lastReleaseAt` + grace sweep).
- **Metric / measure:** Emit `dispatch.framework_overhead_ms` meta (`acp.session.start_ts − dispatch.start_ts`) and compare p50/p95 pool-on vs pool-off via P-Measure-A. Target: overhead approaching the warm 1.9s floor; retries paying ~0 framework cost. Baseline verified at 1.9s (562c7138) / 134.5s (4f1776a9).
- **Change:** Refcounted warm pool for `StdioAcpAdapter` sessions keyed by `(agent, cwd)`, reusing the session via the existing `session/prompt` inject path (`session-registry.ts:665`) instead of cold `session/new`. Replace the unconditional `server.kill()` in finally (`stdio-acp.ts:894`) with release-to-pool when enabled; **health-check before reuse, evict + cold-fallback on any stdin-fatal/abnormal exit**, bound pool entries. Flag-gate per-agent (`agentchat.yaml warm_pool:true`); **pilot codex-acp-fast only** (fast, high-volume, 77 samples).
- **Files:** `packages/agentchat/src/adapters/stdio-acp.ts`, `stdio-acp-server.ts`, `packages/agentchat/src/worker/session-registry.ts`, `packages/daemon/src/long-lived/mcp-pool.ts` (reuse), `packages/agentchat/src/cli/loop.ts`.
- **Reversible:** Y. **Rollback:** `warm_pool:false` (per-agent, hot-reload) → cold-boot + kill-in-finally (current behavior); idle sweep tears down lingering sessions.
- **Risk:** **HIGH, directly on the stability track's surface** (a persistent ACP session is exactly what crashes on stdin-fatal). Hard requirements: **coordinate with the stability track before landing**; a pooled session hitting stdin-fatal must evict cleanly and cold-fall-back, never wedge the pool or hang a worker slot; bound pool size; health-check every reuse. **Do NOT pool until Phases 1–2 ship the measurement** to prove the win and detect regressions. Resolved disagreement: the throughput persona advised *not* to pursue session reuse on a perf track because of wedge overlap; the architect/dispatch personas advised piloting it. **Resolution:** keep it, but **last**, single-agent, flag-gated, gated on the stability track's sign-off and live crash-rate watch — it is the biggest raw lever and the `mcp-pool.ts` pattern already exists, so deferring (not dropping) captures the upside without front-running stability.

---

## 4. Quick Wins (config/flag-only, shippable today)

1. **Phase 0 latency tiebreak** — one comparator line, no flag, zero stability risk. The cheapest latency-aware win; ship independently and immediately.
2. **Repoint synthesizer pins (Phase 3)** — `agentchat.yaml:2145` & `:2224` off claude-acp-sonnet to codex-acp-deep/gemini-acp-pro + `daemon_reload_config`. Config-only, instantly reversible; the only lever on the $2.17/success sonnet sink. (Verify synthesis-quality guard first.)
3. **Surface `cache_read_pct`** in `cost_recent` — read-only, data already in the pipeline; un-blinds the 89%-of-$ anthropic question.
4. **Resolve the granite41-8b PortCollision** so executor/planner agents get the 8B (composite 1.00, 42 tps) instead of the substituted 3B on :7944 — pure ops fix, no code.
5. **llama.cpp tuning for the always-on local coder** (once deployed): `-ngl 999`, flash-attn, `-ub 2048`, q8_0 KV, and the shared-ngram-cache patched binary + `-np 2` per the runbook. Config-only, on the openai-compat path (off the wedge surface).
6. **Default the measured top-byte tools** (`fs_grep`/`dispatch_timeline`/`task_list`/`chain_get_messages`) to `envelope:true` with raw available via explicit flag — near-zero new code, removes the 36–50KB tails from maestro context (a lighter alternative/precursor to Phase 4's central budget).

---

## 5. Cross-Cutting Risks (esp. perf ↔ stability)

- **Traffic concentration onto codex-acp-fast / oc-mimo (Phase 0/2/3).** Demoting claude-acp-sonnet/gemini-acp-pro and pinning faster agents shifts load onto codex/opencode ACP transports. If those have their own stdin-fatal modes, concentration could surface them faster. **Mitigation:** ship behind flags, enable after a canary, and have the stability track watch codex/opencode crash rates under increased share (P-Measure-A provides the live signal).
- **Latency blended over success AND failure rows.** A naive latency term over-promotes fast-but-failing agents (codex-acp-spark 263k/46%, local-gemma 9.3k/0%). **Mitigation:** outcome weight ≥0.28 + a min-success floor gating the latency reward.
- **Queue-inflated latency feeding back into routing.** Using `latency_ms` (enqueue→resolved) in the weighted term would let scheduling delay influence routing. **Mitigation:** Phase 2 MUST consume `exec_ms` from Phase 1, never `latency_ms`.
- **Warm pool ↔ stdin-fatal wedge (Phase 6).** A pooled/reused session is precisely the crashing surface. **Mitigation:** evict + cold-fallback on abnormal exit, health-check before reuse, bound pool, single-agent pilot, land only with stability-track sign-off.
- **Central MCP budget breaking exact-JSON callers (Phase 4).** Workflow lifecycle scripts / `read_handle` round-trips may parse raw shape. **Mitigation:** default-off flag + per-tool exempt-list + preserved envelope/error shapes.
- **memory_recall body cap regressing full-body consumers (Phase 4).** **Mitigation:** on-demand hydrate via `memory_get_observations` (3-layer pattern already used by `memory_search`).
- **Local size-misrouting (Phase 5).** A substantial task classified small could land on a 30B local model and fail. **Mitigation:** conservative classifier, min-success floor, substantial→remote default.
- **No stability regression from measurement (Section 2 / Phase 1).** All read-only / additive-column; zero ACP/worker-path interaction.

---

## 6. Expected End-State (rough projection)

- **Dispatch latency:** Substantial-implement auction share redirected from the 580k–1.64M ms tier to the 197k–304k ms tier (Phase 0/2) → ~6–14 min saved per redirected dispatch. Warm pool (Phase 6) removes the 1.9s–134.5s framework floor on every codex-acp-fast dispatch and makes retries near-free → **~24 worker-hours/day reclaimed** at scale. Trivial work routed local (Phase 5) drops from minutes to ~5–15s.
- **Cost:** claude-acp-sonnet's $2.17/success synthesizer traffic cut by repointing pins (Phase 3); central budget + recall cap trim ~0.3–1M opus tok/24h and slow compaction (Phase 4); local coder carries trivial work at **zero marginal cost**. Anthropic spend (89% of $) becomes legible via `cache_read_pct`.
- **Throughput:** Fleet is **not** slot-saturated today (~2 dispatches/min vs 16 penumbra slots) — gains come from per-dispatch latency + routing, not more slots. Lower per-dispatch latency raises effective throughput headroom; the always-on reader makes it continuously measurable.
- **Measurement:** Month-stale blind tuning → continuous per-agent p50/p95 exec latency, dispatches/hr, queue depth, and provider cache-hit visibility.

---

## 7. Open Questions / Needs a Live Measurement

1. **Is claude-acp-sonnet's 38.2% representative of SYNTHESIS quality, or polluted by devils_advocate/architect persona dispatches?** Needs a per-handoff `dispatch_audit`/`agent_performance` filtered to review_synthesizer + plan_synthesizer handoffs **before** repointing personas (Phase 3 gate).
2. **What fraction of sonnet's 1.64M ms is queue-wait vs execution?** Answered once Phase 1 `exec_ms` lands (`AVG(latency_ms − exec_ms)`); determines whether latency-routing or a concurrency bump is the right lever.
3. **What is the maestro opus `cache_read_pct`?** The single highest-value next measurement (Phase 1) — decides whether the 14.4M opus sink is fine (90% cached) or a fixable preamble-instability bug (50% cached).
4. **What fraction of executor dispatches are trivial (implement_small/docs_mechanical)?** Query `agent_performance` to size the local-routing slice (Phase 5 ROI).
5. **Why did handoff 562c7138 emit `acp.server.start` twice within one handoff** — in-adapter retry, worker re-dispatch, or the stability-wedge crash+respawn? Determines whether the warm pool must survive a crash (evict+cold-fallback) or just normal completion (Phase 6 design input).
6. **Handshake breakdown on the 104.6s gap (4f1776a9):** CLI cold-boot vs MCP server child spawn vs tool-schema load in `session/new`? Tells us whether warm-pool, `strictMcpConfig`/tool-schema trimming (`stdio-acp.ts:197-215`), or both is the bigger lever.
7. **Does adding the latency term compose sensibly with `headroom_weighting`** (quota term, currently disabled in prod)? Confirm a fast-but-quota-pressured vs slow-but-headroom agent resolves sensibly and exploration of unsampled fast agents isn't starved.
8. **Is bench-acp still needed once `exec_ms` capture is live?** Only for capability/quality leaderboard refresh, not latency — confirms its LOW priority.
9. **Are penumbra-1/penumbra-2 slots ever actually filled, or is sticky isolation starving cross-project capacity?** A queue-depth-by-project breakdown (P-Measure-A) before resizing any worker concurrency in `workers.yaml`.
