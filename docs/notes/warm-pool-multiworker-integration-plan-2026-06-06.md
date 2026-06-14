<!-- Generated 2026-06-06 via adversarial planning fan-out (5 lenses + synthesizer): architect, simplifier, test-first, risk-ops, integration. Canary context: docs/notes/acp-warm-pool-rearchitecture-plan-2026-06-05.md + memory warm-pool-reuse-needs-concentrated-load. -->

# Warm pool x multi-worker integration plan

## 1. Problem & root cause

The ACP warm pool (Option B, landed) keeps a warm **codex-acp connection** (process + initialized/authenticated client) in **per-worker-process module memory**, keyed `(agent, repoRoot)`. Each dispatch acquires the warm connection, then issues a **fresh `session/new`** at its own worktree `cwd` and re-injects per-dispatch identity/storage env (`PENUMBRA_HANDOFF_ID`, `PENUMBRA_STORAGE_ROOT`, tick allowlist). This is correct and verified in the code:

- `acp-warm-pool.ts`: `poolKeyFor({agent, cwd})` keys on the **stable repoRoot**, not the per-handoff worktree (`stdio-acp.ts:313` sets `poolScope = repoRoot ?? cwd`; `worktree-integration.ts:85-90` sets `repoRoot = projectRootFor(project_id) ?? mainRepoPath`). So same-`(agent, repoRoot)` dispatches *on the same worker* already reuse.
- The pool is populated **lazily**, as a side effect of a cold dispatch's `deposit` (`stdio-acp.ts:653-661`).
- The registry pool is a per-process singleton, keyed by **agent name** (`acp-warm-pool-registry.ts:9` `pools: Map<string, AcpWarmPool>`); the entries inside it are keyed `(agent, repoRoot)`.

**Root cause of zero reuse for sparse traffic = per-worker pool × first-poll-wins spread.** Worker selection is a first-poll-wins pull: every eligible worker polls `/handoffs` (`event-source.ts:70-99`) and races `claimDispatch` (`handoffs.ts:519`), an atomic CAS with **no agent affinity** (`handoffs.ts:465-564`). Eligibility is purely isolation-scoped: `hard` workers are pinned to their `project_id`; `sticky`/`shared` workers claim cross-project opportunistically when their own queue is empty (`event-source.ts:82-92`, `handoffs.ts:308-334`). With 5 workers and sparse traffic, three sequential probes land on three different workers — each one cold, because that worker's pool was never populated for this `(agent, repoRoot)`, and the 5-min idle grace (`warm_pool_idle_grace_ms` default 300000) expires before any worker is revisited. Reuse engages only under concentrated per-worker bursts. So `acp.session.reuse` stays ~0 and `framework_overhead_ms_p50` never drops for typical usage.

Two confirmations that shape the fix:
- The observability needed to gate this **does not exist yet**: `readFleetLatency` (`packages/core/src/readers/fleet-latency.ts`) aggregates `framework_overhead_ms` from `dispatch.end` rows only — it does **not** surface a reuse rate, nor split overhead by cold vs reuse. `acp.session.reuse` rows *are* persisted to `dispatch_events` (the adapter emits them via `onEvent` at `stdio-acp.ts:355`), so the data exists; only the aggregation is missing.
- `projectRootFor(project_id)` returns `undefined` for any project with no registry resolver, and `worktree-integration.ts` falls back to `mainRepoPath`. For penumbra-1 and penumbra-2 (both `project=penumbra`) this resolves to the **same** repoRoot — so one warm slot per worker covers both, and a single pre-warmed connection is sufficient per worker per agent.

## 2. Approach comparison and decision

| Option | Reliably engages for sparse traffic? | Complexity | Resource cost (idle procs) | Blast radius | Touches first-poll-wins / isolation? | Preserves Option B contract? |
|---|---|---|---|---|---|---|
| **A — per-worker eager pre-warm** | **Yes** — every winning worker is already warm | Low (worker-local only) | `Σ workers × eligible (agent,repoRoot)` — bounded by cap | Low (per-worker, crash-guard already owns these children) | **No** (zero daemon change) | **Yes** (pre-warm deposits a *connection*, never a session) |
| B — agent→worker soft affinity (daemon hint + worker yield) | Mostly — probabilistic; truly sparse can still skip the owner | Med-High (daemon hint column + worker claim-delay) | **Zero new procs** | Med (adds latency on claim; starvation risk if mishandled) | Yes — modifies the claim path (soft delay, not veto) | Yes |
| C — dedicated ACP worker subset | Partial — re-creates spread *within* the subset; needs bursts | Med (workers.yaml + routing rule) | Lower total, but capacity cliff | High (single point of failure for all ACP) | Yes (routing repartition; strands non-ACP capacity) | Yes |
| D — warm-aware claim priority + longer grace | Partial — longer grace just widens the window; priority = claim surgery | Med-High | Zero new procs | Med-High (veto can starve a wedged-owner handoff) | Yes (claim-model change) | Yes |
| E — daemon-managed shared broker | Maximal | Very High | Lowest total | **Very High** — moves child lifecycle into the daemon (fleet SPOF); inverts worker-owns-children; re-opens per-worktree storage-env hazard | Yes (ownership model) | Risky (broker must re-implement per-dispatch re-injection) |

**Decision: ship A (per-worker eager pre-warm) as the primary, with B (soft daemon affinity hint + bounded worker yield) as a deferred, separately-flagged follow-up that is only built if Phase-4 data shows A's idle-process cost is unacceptable.**

Rationale, grounded in the code:
- **A attacks the root cause at the correct seam and is the only liveness-safe guarantee.** The defect is that the pool populates lazily after a cold dispatch lands on a worker. A makes every eligible worker warm *before* any dispatch, so whichever worker wins the first-poll-wins race is warm by construction. It touches **zero daemon code** — `claimDispatch`, the eligibility query, and SSE/poll are byte-unchanged — so it cannot regress first-poll-wins liveness or hard/sticky/shared isolation, the two cleanest invariants in the system. It reuses the existing `getOrCreateAcpWarmPool` registry, the existing `deposit`/`acquire`, and the existing `drainAgent`/`shutdownAllAcpWarmPools` lifecycle. Option B's success is inherently racy to *test* (it asserts cross-worker scheduling under concurrency) and only *raises the probability* of reuse — sparse traffic can still skip the preferred worker. A delivers the metric movement deterministically.
- **A preserves Option B exactly.** Pre-warm deposits a **connection only** — it must never issue `session/new`. Every dispatch still runs the `session/new` + `PENUMBRA_STORAGE_ROOT`/`HANDOFF_ID` re-injection block at `stdio-acp.ts:664-723`, which is the code that prevents a warm-reused process from pointing the penumbra-mcp child at the wrong worktree's DB. This invariant is guarded by a permanent test (Phase 2).
- **The cost is bounded and already governed.** A's only real cost is `Σ workers × eligible (agent,repoRoot)` idle codex-acp processes. We bound it with an isolation-aware eligible-tuple resolver (hard workers warm only their pinned project; sticky/shared warm only their **home** project by default) and a per-worker cap. Because penumbra-1/penumbra-2 collapse to one repoRoot and `warm_pool_max_entries` already caps per-key growth, one warm entry per eligible agent per worker is the steady state.
- **B is the right *second* stage, not the spine.** B recovers reuse for agents too numerous to fully pre-warm and improves cache locality under concentration — but it modifies the claim path, the invariant the constraints forbid disturbing. Defer it behind its own flag and a hard `PENUMBRA_WARM_AFFINITY` kill switch; build only if A's process cost proves untenable *and* reuse plateaus below target.
- **C, D, E rejected** for the reasons in the table: C strands the sticky/shared cross-project elasticity the fleet relies on and re-creates spread inside the subset; D's longer-grace half is subsumed by A's refresh timer and its priority half is claim surgery with worse fairness than B's soft delay; E is far too invasive to clear the ~2026-06-10 crash-guard soak gate and re-opens the per-worktree DB-pointer hazard.

**Sequencing: quick-win A now → measure → only then B if needed.** A is the liveness-safe floor that makes spread irrelevant; B is the optimization layered on top if measured cost demands it.

## 3. Phased TDD plan

All new flags default off. Every phase writes the smallest failing test first, uses real file paths, and gates on `fleet_latency` metrics. Pre-warm is gated behind a **new sub-flag** `warm_pool_prewarm` (distinct from `warm_pool`) so connection-pooling and eager pre-warm can be enabled independently during the soak.

### Phase 0 — Reuse-rate observability (no behavior change)

**Goal:** Make "reuse engaged" a queryable `fleet_latency` field so every later phase has a real exit gate and the canary's 0-reuse becomes a reproducible baseline, not an anecdote. Today `readFleetLatency` reads only `dispatch.end`; `acp.session.reuse`/`acp.server.start` rows exist in `dispatch_events` but are unaggregated.

**Smallest failing test:** In `packages/core/src/readers/fleet-latency.test.ts`, seed `dispatch_events` for one agent with K `acp.server.start` + J `acp.session.reuse` rows plus matching `dispatch.end` rows carrying `framework_overhead_ms`; assert `readFleetLatency(...)` returns per-agent `acp_session_reuse_rate = J/(J+K)`, `framework_overhead_ms_p50_cold`, and `framework_overhead_ms_p50_reuse`. Fails: those fields do not exist.

**Files:**
- `packages/core/src/readers/fleet-latency.ts` (add reuse-rate + cold/reuse overhead split; key the split off whether the dispatch's lifecycle emitted `acp.session.reuse`)
- `packages/core/src/readers/fleet-latency.test.ts`
- `packages/mcp/src/tools/fleet-latency.ts` + `packages/mcp/src/daemon-client.ts` (surface the new typed fields)

**Exit gate:** `fleet_latency` returns `acp_session_reuse_rate`, `framework_overhead_ms_p50_cold`, `framework_overhead_ms_p50_reuse`, and unchanged `exec_ms_p50`, per agent over a window; new test green; querying the live `codex-acp-fast` canary reproduces `reuse_rate ≈ 0` from real data. No production behavior changed.

### Phase 1 — Eligible-tuple resolver (pure function, no processes)

**Goal:** From a worker's own config + isolation + project, compute the exact bounded set of `(agentName, repoRoot)` tuples it should keep warm — provably a subset of what the daemon would route to it. This is where A respects isolation.

**Smallest failing test:** In `packages/agentchat/src/worker/prewarm-targets.test.ts`, a new pure `computePrewarmTargets({ agents, isolation, workerProjectId, resolveProjectRoot, mainRepoPath, cap })` returning `Array<{agent, repoRoot}>`. Assert: (a) only agents with `options.warm_pool === true && options.warm_pool_prewarm === true` are included; (b) a `hard` worker yields only tuples whose `repoRoot === resolveProjectRoot(workerProjectId) ?? mainRepoPath`; (c) a `sticky`/`shared` worker yields its **home** repoRoot for each eligible agent and nothing for projects it does not home; (d) the result is truncated to `cap` with stable ordering; (e) `[]` when no agent opts in. Fails: function does not exist.

**Files:**
- `packages/agentchat/src/worker/prewarm-targets.ts` (new, pure)
- `packages/agentchat/src/worker/prewarm-targets.test.ts` (new)
- `packages/agentchat/src/config/types.ts` (add `warm_pool_prewarm: z.boolean().optional()` and `warm_pool_prewarm_max_targets: z.number().int().min(1).max(10).optional()` to `AgentOptionsSchema`)

**Exit gate:** `computePrewarmTargets` is deterministic, bounded by `cap`, isolation-correct (property test over isolation × project matrix), and each emitted `repoRoot` byte-equals the `poolScope` the adapter computes at `stdio-acp.ts:313` for that project. No subprocesses spawned.

### Phase 2 — `connectAcp()` extraction + `prewarm()` (handshake-only, reuses the cold path)

**Goal:** Factor `startServer + initialize + authenticate + deposit` out of `stdio-acp.ts` (lines ~360-661) into one reusable `connectAcp()` so pre-warm and the in-dispatch cold start produce **byte-identical** warm connections (same `specHash`, same auth-method selection, same env scrub). Expose `prewarm()` that connects + deposits but issues **no `session/new` and no `session/prompt`**.

**Smallest failing test:** In `packages/agentchat/test/adapters/stdio-acp-prewarm.test.ts`, call `adapter.prewarm()` (no `DispatchInput`) with a fake client + injected pool; assert it calls `initialize` then `authenticate` exactly once, deposits an entry whose `specHash === acpSpecHash(opts)`, issues **zero** `session/new`/`session/prompt`, and that an immediately-following `dispatchStream()` emits `acp.session.reuse` (not `acp.server.start`), runs a fresh `session/new` at the dispatch cwd, and re-injects `PENUMBRA_STORAGE_ROOT` per `stdio-acp.ts:699-717`. Fails: `prewarm()` / `connectAcp()` do not exist.

**Files:**
- `packages/agentchat/src/adapters/stdio-acp.ts` (extract `connectAcp`; add `prewarm()` sharing that code path)
- `packages/agentchat/src/adapters/registry.ts` (`createStdioAcpAdapter` already injects the pool when `warmPool === true`; expose the same pool for `prewarm`)
- `packages/agentchat/test/adapters/stdio-acp-prewarm.test.ts` (new)

**Exit gate:** `prewarm()` is handshake-only and deposits an acquirable entry; the next dispatch in-process is a reuse hit with the session/new + per-worktree storage-env re-injection intact; existing `stdio-acp-warm-reuse` + integration-warm-reuse tests stay green (refactor is observationally invisible).

### Phase 3 — Worker-boot pre-warm loop + self-heal refresh (flag-gated, drain-aware)

**Goal:** Wire pre-warm into `agentchat-worker.ts`: at boot (after `registerThoughtAwareAdapters` + config load) compute targets via Phase 1 and `prewarm` each into the **same** `getOrCreateAcpWarmPool(agent)` registry the adapter reads; on a timer at `0.5 × warm_pool_max_age_ms`, re-`prewarm` any target whose pool entry is missing/aged (replace-before-evict); on config reload, recompute targets and reuse the existing drain diff at `agentchat-worker.ts:1320-1344`; on shutdown, stop the loop before `shutdownAllAcpWarmPools()` at line 1352. **All pre-warm errors are caught + backed off inside the loop** so a spawn failure never bubbles to the crash guard.

**Smallest failing test:** In `packages/agentchat/test/worker/prewarm-loop.test.ts`, extract a pure `prewarmLoop({ computeTargets, prewarmOne, pool, clock, cap })`. With one `warm_pool + warm_pool_prewarm` agent and a fake clock + fake `connectAcp`: assert (a) one deposit per target at boot keyed `(agent, thisWorkerRepoRoot)`, ZERO for a project this worker does not home; (b) a spawn that throws schedules bounded backoff and does not crash the loop; (c) refresh re-`prewarm`s only when the prior entry has aged past `max_age`; (d) flag off ⇒ zero spawns; (e) drain on reload stops the loop for the de-flagged agent. Fails: loop module does not exist.

**Files:**
- `packages/agentchat/src/worker/prewarm-loop.ts` (new — injectable clock + `prewarmOne` + per-agent backoff/breaker)
- `packages/agentchat/bin/agentchat-worker.ts` (start loop after `registerThoughtAwareAdapters`; hook `onConfigReload`; `unref` the timer; tear down in `shutdown`)
- `packages/agentchat/test/worker/prewarm-loop.test.ts` (new)

**Exit gate:** With `warm_pool_prewarm:true`, a simulated boot leaves exactly one acquirable warm entry per eligible target before any dispatch; refresh replaces an aged entry within one interval; flag default off ⇒ behavior byte-identical to today (existing worker-boot tests green); a pre-warm child crash is contained by backoff (no tight respawn loop); `SIGTERM` tears down all pre-warmed connections (no orphaned codex-acp PIDs).

### Phase 4 — Bounded-process invariant + crash-rate guard (cost ceiling)

**Goal:** Prove A's idle-process cost is bounded and cannot amplify the worker crash-storm the soak watches. Cap total warm processes per worker; a repeatedly-crashing pre-warm target trips a per-agent breaker (stops pre-warming that agent) rather than looping.

**Smallest failing test:** In `packages/agentchat/test/worker/prewarm-bounds.test.ts`, configure 10 opted-in agents with `warm_pool_prewarm_max_targets`/global cap = 2; assert the loop spawns at most `min(eligible, cap)` processes; a non-zero exit is not re-spawned faster than backoff; repeated crashes trip the breaker. Add a count accessor on `acp-warm-pool-registry.ts` for the cap. Fails: cap/backoff/breaker absent.

**Files:**
- `packages/agentchat/src/worker/prewarm-loop.ts` (global cap + per-agent breaker)
- `packages/agentchat/src/adapters/acp-warm-pool-registry.ts` (expose total-entry count for the cap)
- `packages/agentchat/test/worker/prewarm-bounds.test.ts` (new)

**Exit gate:** Total warm processes per worker `≤` cap under any agent count (verified via `pgrep` count in a scripted local run); crash contained by backoff + breaker; `worker code:1`/EPIPE rate flat vs the pre-pre-warm baseline before the flag is flipped in production.

### Phase 5 — Canary on codex-acp-fast + metric gate (closes Phase 0's loop)

**Goal:** Enable `warm_pool_prewarm:true` for `codex-acp-fast` across the 5-worker topology and re-run the exact 3-sequential-probe validation that returned 0/3 reuse on 2026-06-06.

**Smallest failing test:** Extend the canary probe harness with an assertion that `acp_session_reuse_rate` for `(codex-acp-fast, repoRoot)` over the probe window is `≥ 0.6` across 3 sequential probes landing on `≥ 2` distinct workers. Starts RED against today's `≈ 0` baseline; green only after pre-warm is live.

**Files:**
- `packages/agentchat/test/adapters/stdio-acp-integration-prewarm.test.ts` (new; modeled on `stdio-acp-integration-warm-reuse.test.ts` using the `acp-recorder.ts` fixture — pre-warm ONE real child, then dispatch at a worktree cwd; assert `startServer` called once by prewarm, dispatch emits `acp.session.reuse`, session/new ran fresh at the dispatch cwd, `PENUMBRA_STORAGE_ROOT` reached session/new)
- Canary config: `~/.config/penumbra/agentchat.yaml` `codex-acp-fast` gets `warm_pool_prewarm: true` (operator-applied via `daemon_reload_config`, not committed — the worker hot-reload path at `agentchat-worker.ts:1320` propagates it)

**Exit gate:** Real-subprocess test green; on the canary, `acp_session_reuse_rate ≥ 0.6` across probes spread over `≥ 2` workers; `framework_overhead_ms_p50_reuse` materially below `_cold`; `exec_ms_p50` within noise of baseline; `worker code:1`/EPIPE flat over a `≥ 30-min` observation; per-worker warm-process count `≤` cap and stable (no leak).

### Deferred Phase 6 (build only if needed) — Soft daemon affinity hint (Option B)

Only if Phase 5 shows A's idle-process cost is acceptable but reuse plateaus below target due to eviction churn, or the production agent count makes full pre-warm too heavy: add a soft `preferred_worker_id` + `preferred_until_ts` (TTL = `warm_pool_idle_grace_ms`) hint to the handoff list/SSE payload, derived from the last worker that completed a warm-eligible dispatch for `(to_agent, project_id)`. Non-preferred, warm-eligible workers apply a bounded jittered claim delay (`warm_affinity_yield_ms`, hard-capped at `min(grace/4, 1500ms)`, one-yield-per-handoff) **only while the hint is fresh and the owner is heartbeat-healthy**; everyone falls back to immediate claim otherwise. Gated by `PENUMBRA_WARM_AFFINITY` (kill switch → instant revert to pure first-poll-wins). It is a delay, never a veto, so liveness is preserved. This is a separate plan; do not build it in this integration unless the data demands it.

## 4. Flag-gating, rollout/rollback, resource bounds, soak interaction, observability

**Flags (all default off):**
- `warm_pool` (existing) — enables connection pooling on the dispatch path.
- `warm_pool_prewarm` (new, Phase 1) — enables eager boot pre-warm + self-heal. Decoupled from `warm_pool` so the canary can run connection-pooling and pre-warm independently through the soak.
- `warm_pool_prewarm_max_targets` (new) + a global per-worker cap (Phase 4).
- `PENUMBRA_WARM_AFFINITY` env kill switch reserved for deferred Phase 6.

**Rollout:** (1) Land Phases 0-4 with `warm_pool_prewarm` off everywhere → zero behavior change. (2) After the ~2026-06-10 crash-guard soak clears AND Phase 4's crash-rate gate holds locally, flip `warm_pool_prewarm:true` for `codex-acp-fast` only (Phase 5), one agent, via `daemon_reload_config`. (3) Hold ≥ 48h; if green, widen agent-by-agent. **Rollback:** set the flag false and `daemon_reload_config`; the existing reload diff (`agentchat-worker.ts:1323`) drains the pool and the loop stops within one reload — idle-process count returns to zero.

**Resource bounds:** Per-worker warm processes `= min(Σ eligible (agent,repoRoot), cap)`. Eligibility is isolation-scoped (hard = pinned project; sticky/shared = home project only), penumbra-1/penumbra-2 collapse to one repoRoot, and `warm_pool_max_entries` caps per-key growth. Phase 4 enforces and verifies the ceiling via `pgrep`. Cross-project pre-warm for sticky/shared is **not** done by default (it would explode the count); cross-project claims simply pay the cold floor (the rare case).

**Crash-guard soak interaction (~2026-06-10):** Pre-warm adds long-lived children. To avoid amplifying the `code:1` crash-storm the guard (P1, 99b51e78) contains: pre-warm failures are caught + backed off **inside the loop** and never propagate to a top-level crash path (Phase 3 gate); a per-agent breaker stops a flapping target (Phase 4). The flag stays off until the soak clears and Phase 4's crash-rate gate is green. On `SIGTERM`, the loop stops before `shutdownAllAcpWarmPools()`; on a stale-sweep `SIGKILL` the children orphan — bound the leak with `unref`'d handles and (if the sweeper uses SIGKILL — see open questions) a boot-time orphan sweep of stale codex-acp groups owned by this `worker_id`.

**Observability / verification:** Phase 0 makes `acp_session_reuse_rate`, `framework_overhead_ms_p50_{cold,reuse}`, and `exec_ms_p50` first-class `fleet_latency` fields per agent. Every later gate reads them. The canonical acceptance signal is the canary's `reuse_rate` moving off 0 across `≥ 2` distinct workers with `exec_ms_p50` flat and `code:1`/EPIPE flat.

## 5. Open questions

1. **Production agent count.** How many distinct stdio-acp agents will be `warm_pool_prewarm`-eligible in the real ~58-agent `agentchat.yaml` (NOT the 9-line repo skeleton)? This sets the per-worker idle-process ceiling and whether the cap must be tighter than `warm_pool_max_entries`. Read from production config before fleet-wide enablement.
2. **Stale-sweeper signal.** Does the stale-sweeper `SIGKILL` or `SIGTERM`-with-grace workers? If SIGKILL, `shutdownAllAcpWarmPools` never runs and the boot-time orphan sweep is mandatory, not optional.
3. **Idle-tolerance of codex-acp.** Does an initialized+authenticated codex-acp connection survive idle for up to `warm_pool_max_age_ms` (30 min default) without the upstream CLI self-terminating or rotating its session token? If it reaps idle connections, `max_age` and the refresh cadence must drop below that threshold.
4. **Auth side effects.** Does `authenticate` have side effects (rate-limited token mint, plan-limit counters) that make eager boot pre-warm risky for subscription agents? If so, stagger pre-warm or restrict it to api-pricing agents first.
5. **Sticky/shared cross-project default.** Phase-5 data on how often sticky/shared workers actually claim cross-project should decide whether home-project-only pre-warm leaves meaningful reuse on the table (and thus whether deferred Phase 6 affinity is worth building).
6. **projectRegistry coverage.** Confirm every claimable project resolves a distinct `projectRootFor` value; multiple projects collapsing to `mainRepoPath` would make a pre-warmed entry reusable for the wrong repo. (Verified safe for penumbra-1/penumbra-2; confirm for omlx/llamactl/shared.)

## 6. Risks

- **Idle-process footprint** — A trades RAM/FDs for latency. Mitigated by the Phase-1 isolation-scoped resolver + Phase-4 cap + breaker; verified by `pgrep`. The single biggest reason to keep B in reserve.
- **Crash-guard amplification** — a flaky binary turns boot pre-warm into a crash amplifier. Mitigated by in-loop catch + backoff + per-agent breaker + flag-off-until-soak-clears.
- **Stale warm connection on reuse** — a long-idle process whose stdin went non-writable. `isRunning()` already gates `acquire` (`acp-warm-pool.ts:72-83`) and `AcpSessionEvictedError` falls back to cold (`stdio-acp.ts:1014-1031`); reuse rate going up MUST be checked against EPIPE/`code:1` staying flat (the explicit soak metric).
- **Pool-key drift** — the pre-warmer must deposit with the same `poolKeyFor(agent, repoRoot)` (agent = `agentName ?? model ?? binary`; repoRoot = `projectRootFor ?? mainRepoPath`) the dispatch acquires, or warm processes sit in a key no dispatch reads (zero reuse despite spawns). Guarded by sharing `poolKeyFor` + asserting key byte-equality in Phases 1-3.
- **Stale-auth / spec drift** — pre-warmed process env is frozen at warm time; a config reload changing binary/args/model changes `specHash`, and `acquire` already tears down on mismatch (`stdio-acp.ts:133`) — the refresh loop must re-warm with the new spec; drain must stop the loop (Phase 3 gate). Per-dispatch identity is unaffected because session/new re-injection runs every dispatch.
- **Pre-warm masking cold-path regressions** — if dispatches rarely cold-start, a broken cold `session/new` could go unnoticed. Mitigated by Phase 2 sharing the exact handshake code (`connectAcp`) so the cold path is still exercised on first boot + spec change, and keeping the cold-path tests in CI unconditionally.
