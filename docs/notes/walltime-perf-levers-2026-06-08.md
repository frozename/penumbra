# Wall-time / performance levers — 2026-06-08

Source: `penumbra-walltime-perf-hunt` workflow (wf_fde29710-1c2, 54 agents, 6 lenses + adversarial verify). 22 levers confirmed-real. Ranked by value/effort. Full output: the run's task file.

## Tier 1 — the headline win

### L1. Warm-pool coverage: enable warm_pool on the 7 cold-starting ACP agents (HIGH, S, config-only)
Only **2 of 12** ACP agents have warm_pool (codex-acp-fast reuse 0.58, claude-acp-sonnet reuse 1.0). The other high-dispatch executor/reviewer agents — **codex-acp-spark, codex-acp, codex-acp-deep, gemini-acp-pro, gemini-acp-flash, claude-acp-haiku, oc-acp-deepseek-v4-pro** — lack it, so every first/sparse dispatch pays the full ACP cold-start (~50-170s: codex ~50-100s, claude ~100-170s, gemini ~30-80s). Proven-safe pattern (reuses connections not sessions; fresh session/new per dispatch at its cwd; pool keyed per agent+repoRoot).
- **Reuse (warm_pool:true)** is cheap + low-resource (connection warms on first dispatch, stays `idle_grace`=5min) → wins on bursty 2nd+ dispatches; first dispatch still cold.
- **Prewarm (warm_pool_prewarm:true)** eliminates the first cold-start too, BUT is a persistent ACP child per (agent×worker) and is capped at `PENUMBRA_WARM_PREWARM_CAP=4` per worker. Enabling prewarm on all 9 (2+7) with 5 workers ⇒ up to 45 persistent ACP children if the cap is raised — a real memory/process cost. Measured approach: warm_pool:true on all 7; prewarm only the top ~2-3 highest-frequency executors within the existing cap=4.
- File: `~/.config/agentchat/agentchat.yaml` (production fleet config). Rollback: warm_pool:false + `daemon_reload_config`. Blast radius: changes live fleet; needs reload/restart + verify reuse_rate via fleet_latency.

## Tier 2 — cheap in-repo code wins (S effort)
- **L2. Daemon sweeper cadence** (loop-contention, ~ms/min each): orchestrate-reactor 5s→30s (backstop, clearly safe); task-leases 15s→30s (TTL 10min, safe); plan-runtime 5s→15s; bounds-tracker 5s→10s (budget enforcement — slight late-detection risk). Files in `packages/daemon/src/{sweepers,reactors,maestro}/`.
- **L3. capture-port.close() off the dispatch.end critical path** (`packages/agentchat/src/worker/loop.ts:154`): emit dispatch.end before awaiting close; fire-and-forget the flush. ~20-100ms on saturated workers.
- **L4. stale-handoff per-handoff event fetch** (`sweepers/stale-handoff.ts:110`): batch the per-handoff `dispatch_events` query into one (index already exists). Modest.
- **L5. worktree create: parallelize node_modules symlink mirroring** (`core/src/worktree/manager.ts:366`) — ~10-15ms/worktree (verifier downgraded from 150-300ms). Minor.

## Tier 3 — M effort / observability / speculative
- **L6. agent-performance capture JSON.parse per handoff** (`agent-performance-capture.ts:125`): index on (handoff_id, kind) / denormalize worktree_changed. ~3-6ms/handoff.
- **L7. dispatch-events stream replay JSON.parse** (`routes/dispatch-events.ts:178`): memoize/parse-at-publish. 10-40ms/subscriber.
- **L8. Queue-aware routing**: derank agents by current queue_depth in `agent-routing.ts:484` — 300-800ms IF misroutes are 20-50% of traffic (speculative, some risk).
- **L9. Dynamic claim-affinity grace** (`claim-affinity.ts`): drop the 500ms grace to 0 under deep queue / no idle home worker. Needs pressure signal plumbing.
- **L10. Queue-latency SLA metric** (approve→claim gap): add `approved_at` + a fleet_latency queue_latency_p50/p95 (observability that unblocks L8/L9 tuning).
- Deferred: reconciler timeout instrumentation, MCP-pool sweep 60s→300s event-driven, worker-health-probe + orphan-recovery consolidation (15s→20s), bun.lock copy-on-create skip.

## Cross-cutting
- **worktree-gc can't reap worker-created worktrees** (daemon WorktreeManager doesn't track them) — 54 orphans accumulated this/prior sessions (reaped manually 2026-06-08). Real follow-up: make worktree-gc / the reconciler reap orphaned `penumbra-worktrees/<uuid>` dirs whose dispatch is terminal.
