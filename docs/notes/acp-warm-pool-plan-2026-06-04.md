# ACP warm pool — phased TDD plan (perf B1 / Phase 6)

> Source: adversarial-plan (architect/simplifier/risk/integration + synth), 2026-06-04. Eliminates the per-dispatch stdio-acp cold-start via a per-worker refcounted session pool. Flag-gated (warm_pool, default off), pilot codex-acp-fast.

All anchors verified. Key findings that resolve planner conflicts:

- `stdio-acp.ts`: single unconditional `server.kill()` at line 894 inside the outer `finally` (line 889); `unregisterSession` at 891; `session/new` at 659; `acp.session.start` emit at 672; `session/prompt` at 830; `acp.server.start` at 294.
- `PENUMBRA_HANDOFF_ID` is injected into `session/new` params at line 610 (`[{ name: "PENUMBRA_HANDOFF_ID", value: input.handoff_id }]`) — **confirming the integration lens's hazard**: warm reuse skips `session/new`, so the handoff ID would stick to the first dispatch unless re-injected per-prompt.
- `fleet-latency.ts` uses `percentileNearestRank(values, 0.5/0.95)` — **not** `PERCENTILE_CONT` SQL (architect was wrong; risk/integration "no daemon reader change unless adding a column" is closer).
- `registry.ts:194` `buildAdapter` is called per-dispatch from `loop.ts:99` — **confirming risk lens**: a per-adapter pool would be inert; a worker-level singleton/registry is required.
- Config: `AgentOptionsSchema` is `z.looseObject`, `options: AgentOptionsSchema.default({})`.

Here is the merged plan.

---

# ACP Warm Pool — Merged Phased TDD Plan

A per-worker, refcounted pool of live ACP CLI sessions keyed by `(agent, cwd)`. On a warm hit, a dispatch skips `startServer` + `initialize` + `authenticate` + `session/new` and goes straight to `session/prompt`, collapsing the measured 104–134s cold floor toward the ~1.9s warm floor. Additive, reversible, flag-gated (`warm_pool`, default off), single-agent pilot (`codex-acp-fast`).

## Conflicts resolved (winner + one-line justification)

1. **Health-check: liveness flag vs `session/prompt` ping.** Winner: **risk/integration liveness check** (`exitCode==null && signalCode==null && stdin.writable`), with an **optional empty `session/prompt` ping behind a config flag, default off**. The architect/simplifier ping burns a real agent turn or adds round-trip latency on every reuse; the synchronous flag check is free and catches the stdin-fatal wedge surface, which is the actual failure mode. (Simplifier's own trade-offs section concedes the ping is the weak point.)
2. **Pool key.** Unanimous: `(agent, cwd)` only — `trust_mode`/`task_class` excluded (dispatch-level, not session-level). No conflict.
3. **fleet-latency surfacing.** Winner: **risk lens** — the reader uses `percentileNearestRank`, not SQL `PERCENTILE_CONT` (architect's SQL is wrong for this file). Metric flows as a new `agent_performance` column read the same way as `exec_ms`.
4. **Metric carrier.** Winner: **architect/risk** — `framework_overhead_ms` persisted as an `agent_performance` column via `dispatch.end` meta (queryable, p-tile-able), **plus** simplifier's lightweight lifecycle event for live `dispatch_timeline` visibility. Both, since they serve different consumers (DB aggregation vs timeline).
5. **Pool ownership.** Winner: **risk/integration registry singleton** — `buildAdapter` is per-dispatch (verified line 194/99), so a per-adapter pool is inert. A module-level registry keyed by agent is mandatory, not optional.
6. **`PENUMBRA_HANDOFF_ID` on reuse.** Winner: **integration lens hazard is real** (verified: injected only in `session/new` params at line 610). Phase 4 carries a blocking sub-task to re-inject the handoff id per-prompt or via `session/update`; resolved before reuse lands.
7. **Phase count.** Winner: **simplifier scope** as the spine (4 core phases), absorbing risk's distinct eviction/lifecycle hazards as sub-steps rather than 8 separate phases. The merged plan is 6 phases vs risk's 9.

---

## Phase 0 — Schema flag + telemetry instrument (no behavior change) — INDEPENDENT

**Why first:** Purely additive; establishes the measurement instrument so the pilot has before/after numbers from day one. Unblocks Phases 1 and 3 in parallel.

**Failing tests**
- `packages/agentchat/test/config/agent-options-warm-pool.test.ts` (new)
  - `AgentOptionsSchema.parse({ warm_pool: true })` ok; `parse({})` → `warm_pool === undefined`; `parse({ warm_pool: "yes" })` throws.
  - `warm_pool_idle_grace_ms` accepts `[1000, 3600000]`, rejects out-of-range.
- `packages/agentchat/test/adapters/stdio-acp-overhead.test.ts` (new)
  - cold dispatch: `dispatch.end` meta `framework_overhead_ms >= 0`; `acp.session.start` meta carries `framework_overhead_ms`.

**Impl**
- `packages/agentchat/src/config/types.ts` — after `terminal_max_concurrent` (line 26), add to `AgentOptionsSchema`:
  ```ts
  warm_pool: z.boolean().optional(),
  warm_pool_idle_grace_ms: z.number().int().min(1000).max(3600000).optional(),
  warm_pool_max_age_ms: z.number().int().min(10000).max(86400000).optional(),
  warm_pool_max_entries: z.number().int().min(1).max(10).optional(),
  warm_pool_health_ping: z.boolean().optional(), // default off; empty session/prompt liveness ping
  ```
- `packages/agentchat/src/adapters/stdio-acp.ts` — record `dispatchStartTs = Date.now()` at top of `dispatchStream`; at the `acp.session.start` emit (line 672) add `framework_overhead_ms: Date.now() - dispatchStartTs` to meta; thread the same into the final `done`/`dispatch.end` meta. Add `"acp.session.reuse"` to the dispatch-event kind schema (used Phase 4).

**Verify**
```
cd packages/agentchat && bun test test/config/agent-options-warm-pool.test.ts test/adapters/stdio-acp-overhead.test.ts
```
**Restart:** none.

---

## Phase 1 — `AcpWarmPool`: refcount + grace-sweep + liveness + eviction (pure unit) — INDEPENDENT

**Why:** The pool is a dependency-injected data structure mirroring `mcp-pool.ts`. Testable in full isolation with a mock `StdioAcpHandle`; no adapter surgery, no real CLI.

**Failing tests** — `packages/agentchat/test/adapters/acp-warm-pool.test.ts` (new)
- `acquire` for empty key returns null; `deposit` then `acquire` retrieves it.
- second `acquire` of same key reuses entry (no re-deposit); `refs` tracks holders.
- `release` at `refs.size===0` sets `lastReleaseAt`; `_sweep()` past `graceMs` calls `handle.kill()` once and deletes entry.
- liveness: dead handle (`exitCode=1`) or `stdin.writable===false` at acquire → evicted, returns null.
- `maxEntries` full + all idle → evict oldest `lastReleaseAt`; full + all held (`refs.size>0`) → returns null (cold-fallback).
- `maxAgeMs` exceeded at acquire → evict.
- `specHash` (binary+args+model) mismatch at acquire → evict (mirrors `mcp-pool.ts:296`).
- **concurrent acquire same key serialized** — only one entry returned, no double-use (a held entry is never handed to a second dispatch).
- `deposit`-time exit listener: idle handle exit fires → entry self-evicts before next acquire.
- double-evict is idempotent (`kill` not called twice).
- `shutdown()` kills all, clears sweep interval, subsequent acquire returns null.

**Impl** — new file `packages/agentchat/src/adapters/acp-warm-pool.ts`
```ts
type PoolEntry = {
  handle: StdioAcpHandle; client: StdioAcpClient; sessionId: string;
  refs: Set<string>; lastReleaseAt?: number; spawnedAt: number;
  specHash: string; tornDown?: boolean;
};
export function poolKeyFor(o: { agent: string; cwd: string }): string; // `${agent}\0${cwd}`
export function createAcpWarmPool(deps?: {
  now?: () => number; graceMs?: number; maxAgeMs?: number; maxEntries?: number;
}): AcpWarmPool;
```
- Mirror `mcp-pool.ts` verbatim for: `refs` Set + `lastReleaseAt`, `isRunning` (`exited` not settled && `stdin.writable`), `specHash`, `setInterval(sweep, 60_000).unref()`.
- `acquire(holderId, key)`: walk entries; skip `refs.size>0` (in-use); liveness+age+spec check the first idle one; return it (add holderId) or null. **An ACP session serves at most one active dispatch** (session/prompt is sequential) — capacity holds multiple entries for concurrency, never shares one.
- Defaults: `graceMs=300_000`, `maxAgeMs=1_800_000`, `maxEntries=3`.
- `deposit`: register `handle.exited.then(code => code && evict(...))` so idle stdin-fatal self-evicts.
- `evict`: idempotent `kill()` + delete.

**Verify**
```
cd packages/agentchat && bun test test/adapters/acp-warm-pool.test.ts
```
**Restart:** none.

---

## Phase 2 — Adapter integration, cold path byte-identical — SEQUENTIAL (after 1)

**Why:** Graft the pool into `dispatchStream` behind the flag. The disabled path must be bit-for-bit unchanged — this is the reversibility guarantee.

**Failing tests** — `packages/agentchat/test/adapters/stdio-acp.test.ts` (extend)
- `warm_pool:false` (and `undefined`): `server.kill()` called exactly once in `finally` on every outcome (clean, prompt timeout, `session/new` throw); **no** `pool.*` ever called. Byte-identical to current.
- `warm_pool:true` + injected mock pool, clean completion: `pool.deposit`/`release` called, `server.kill()` NOT called (pool owns the handle).
- `warm_pool:true`, `session/prompt` throws: `pool.evict` called AND `server.kill()` called.

**Impl** — `packages/agentchat/src/adapters/stdio-acp.ts`
- `StdioAcpAdapterDeps` gains `pool?: AcpWarmPool`; `StdioAcpOptions` gains `warmPool?: boolean`.
- The single outer `finally` (line 889) becomes:
  ```ts
  if (input.handoff_id) unregisterSession(input.handoff_id);
  if (this.opts.warmPool && this.deps.pool && entry && !errorThrown) {
    this.deps.pool.release(holderId, key);   // pool owns handle; do NOT kill
  } else {
    if (this.opts.warmPool && this.deps.pool && entry) this.deps.pool.evict(key); // error path
    if (server) server.kill();               // unchanged cold/eviction path
  }
  ```
  Cold-path guard short-circuits before any pool call. `errorThrown` set in the `catch` before re-throw.

**Verify**
```
cd packages/agentchat && bun test test/adapters/stdio-acp.test.ts && bun test
```
**Restart:** none (still no warm wiring at the worker).

---

## Phase 3 — Metric persistence: `framework_overhead_ms` in `agent_performance` + fleet_latency — INDEPENDENT

**Why:** Closes the measurement loop in the DB. Runs in parallel with Phases 1–2; only depends on Phase 0's meta emission.

**Failing tests**
- `packages/core/test/services/agent-performance-capture.test.ts` (extend): persists `framework_overhead_ms` from `dispatch.end` when present; leaves null when absent.
- `packages/core/test/readers/fleet-latency.test.ts` (extend): returns `framework_overhead_ms_p50/_p95` per agent when rows present; null when none set.

**Impl**
- `packages/core/src/db/schema.ts` — `framework_overhead_ms INTEGER` via `addColumnIfMissing` at the existing `exec_ms` site.
- `packages/core/src/schemas/agent-performance.ts` — `framework_overhead_ms: z.number().int().nullable().optional()`.
- agent-performance-capture writer — add to the upsert beside `exec_ms`.
- `packages/core/src/readers/fleet-latency.ts` — collect `framework_overhead_ms` per agent and compute `framework_overhead_ms_p50/_p95` via the existing **`percentileNearestRank`** helper (NOT SQL `PERCENTILE_CONT`); add the two fields to `FleetLatencyRow`. `/agents/fleet_latency` forwards verbatim — no daemon endpoint change.

**Verify**
```
cd packages/core && bun test test/services/agent-performance-capture.test.ts test/readers/fleet-latency.test.ts
```
**Restart:** daemon (schema migration + reader run at daemon start).

---

## Phase 4 — Warm reuse path + handoff-id re-injection + eviction recovery — SEQUENTIAL (after 2)

**Why:** The behavioral core and the critical safety phase, combined: acquire→reuse, plus stdin-fatal mid-turn recovery, plus the verified `PENUMBRA_HANDOFF_ID` hazard.

**Failing tests** — `packages/agentchat/test/adapters/stdio-acp-warm.test.ts` (new)
- two sequential `warm_pool:true` dispatches, same `(agent,cwd)`: `startServer` called once; `session/new` once; `session/prompt` twice; `acp.server.start` emitted once; `acp.session.reuse` emitted on the 2nd.
- pool hit: `framework_overhead_ms` near-zero (mock clock).
- pool miss: cold-start, `server.kill()` in finally.
- reuse path clears prior turn's `session/update` listeners (no handler leak across dispatches).
- **handoff-id**: 2nd dispatch's `session/prompt` carries the *new* `input.handoff_id` (not the 1st) via `_meta` / `session/update` — penumbra-mcp attribution stays correct.
- stdin-fatal mid-turn: process exits code 1 → in-flight `session/prompt` loses a `Promise.race` to an exit detector rejecting `AcpSessionEvictedError{retryable:true}` → `pool.evict` → one in-adapter cold-retry → dispatch completes; `dispatch.start` not double-billed.
- cold-fallback-also-fails: error propagates normally, no double-kill, pool not corrupted.
- evict with active ref: holder gets the error, not a hang.

**Impl** — `packages/agentchat/src/adapters/stdio-acp.ts`
- Before `startServer`: if `warmPool && deps.pool`, `entry = pool.acquire(holderId, poolKeyFor({agent, cwd}))`.
  - **hit:** reuse `entry.{handle,client,sessionId}`; skip `startServer`/`initialize`/`authenticate`/`session/new`; emit `acp.session.reuse {session_id, pool_key, framework_overhead_ms}`.
  - **miss:** cold path unchanged; on `session/new` success, `pool.deposit(key, {handle,client,sessionId})`.
- **Handoff-id re-injection (blocking sub-task):** inspect penumbra-mcp's `session/prompt` handler. If it reads `_meta.penumbraHandoffId`, inject there per-prompt; else emit an ACP `session/update`-style env patch before the prompt. Do not land reuse until verified — else warm dispatches attribute to the first handoff.
- Attach a one-time `entry.handle.exited.then(onExit)` that sets `entryEvicted`, calls `pool.evict`, and rejects the prompt with `AcpSessionEvictedError`. In `catch`, if `AcpSessionEvictedError && warmPool`, cold-retry once inline (intra-adapter, NOT the turn-level retry in `dispatch-handoff.ts`).

**Verify**
```
cd packages/agentchat && bun test test/adapters/stdio-acp-warm.test.ts && bun test
```
**Restart:** none yet (worker wiring is Phase 5).

---

## Phase 5 — Worker pool registry (singleton) + hot-reload drain — SEQUENTIAL (after 4)

**Why:** `buildAdapter` is per-dispatch (registry.ts:194 ← loop.ts:99) — a per-adapter pool is inert. The pool must be a per-worker singleton living across adapter instances.

**Failing tests** — `packages/agentchat/test/worker/acp-pool-wiring.test.ts` (new)
- two `buildAdapter("stdio-acp", {warmPool:true})` for the same agent receive the **same** pool instance (identity); `warm_pool:false`/absent → `pool` undefined.
- `normalizeAdapterOptions`: `cfg.options.warm_pool` → `warmPool` (+ the grace/age/maxEntries/health-ping knobs) in adapter opts.
- `shutdownAll()` invoked on SIGTERM/SIGINT kills all entries, clears intervals.
- hot-reload `warm_pool:true→false`: subsequent dispatches cold-path (no new deposits); existing idle entries drain via sweep within one grace window.

**Impl**
- new `packages/agentchat/src/adapters/acp-warm-pool-registry.ts`: module-level `Map<agent, AcpWarmPool>` with `getOrCreate(agent, opts)`, `shutdownAll()`, `drainAgent(agent)`.
- `packages/agentchat/src/cli/adapter-options.ts` — map `warm_pool*` options → `warmPool*`.
- `packages/agentchat/src/adapters/registry.ts` (`buildAdapter`, line 18/194) — when `warmPool===true`, inject `pool: getOrCreatePool(agent, opts)` into `StdioAcpAdapterDeps`.
- `packages/agentchat/src/cli/loop.ts` — own the registry for the worker lifetime; register `shutdownAll()` on SIGTERM/SIGINT and on the crash-guard flush callback.
- daemon_reload_config path — call `drainAgent(agent)` when an agent's `warm_pool` toggles false. (Hot-reload already propagates yaml to running workers per landed 5cf0d210.)

**Verify**
```
cd packages/agentchat && bun test test/worker/acp-pool-wiring.test.ts && bun test
```
**Restart:** agentchat worker restart to load the registry wiring (one-time; subsequent flag toggles are hot-reload).

---

## Phase 6 — Integration cold-fallback + pilot canary gate — SEQUENTIAL (after 5)

**Why:** One real-subprocess test catches eviction timing races unit mocks miss; then the operational gate.

**Failing test** — `packages/agentchat/test/adapters/stdio-acp-integration-cold-fallback.test.ts` (new, `test.timeout(10_000)`)
- Real minimal ACP fixture `test/fixtures/acp-minimal.ts` (responds to `initialize`/`session/new`/`session/prompt` with `{stopReason:"end_turn"}`, text `"ok"`).
- deposit a real handle, SIGKILL it, dispatch again → liveness fails → evict → `startServer` 2nd time → completes; pool has new entry, count never negative, slot not blocked.
- exit event after a *successful* dispatch (idle kill) handled without error (no stale evict-in-flight).

**Verify**
```
cd packages/agentchat && bun test test/adapters/stdio-acp-integration-cold-fallback.test.ts
```

**Pilot canary (operational — pause for operator):**
1. Confirm all Phases 0–6 green, P1 crash-guard (99b51e78) stable in prod ≥1 week.
2. `agentchat.yaml`, `codex-acp-fast` only:
   ```yaml
   options:
     warm_pool: true
     warm_pool_idle_grace_ms: 300000
     warm_pool_max_age_ms: 1800000
     warm_pool_max_entries: 3
   ```
3. `daemon_reload_config` (worker already restarted in Phase 5). Capture 24h `warm_pool:false` baseline first.
4. Watch 2–24h via `fleet_latency --agent codex-acp-fast`: `framework_overhead_ms_p50` → target ≤2s; `exec_ms_p50` must not regress; `acp.session.reuse` count climbs to 70–90% on sequential dispatches; worker stderr `code:1`/`EPIPE` rate must not rise above pre-pool baseline.
5. **Rollback:** `warm_pool:false` + `daemon_reload_config` (hot, no restart). Idle entries drain via sweep within one grace window. No data-layer revert.

**Restart:** worker for `codex-acp-fast` only (rolling); daemon already restarted in Phase 3.

---

## Phase dependency / parallelism

| Phase | Depends on | Parallelizable with |
|---|---|---|
| 0 schema+telemetry | — | 1, 3 |
| 1 pool unit | — | 0, 3 |
| 2 adapter integration (cold-identical) | 1 | 3 |
| 3 metric persistence + reader | 0 | 1, 2 |
| 4 warm reuse + eviction recovery | 2 | 3 |
| 5 worker registry + hot-reload | 4 | 3 |
| 6 integration test + canary | 5 | — |

Critical path: 1 → 2 → 4 → 5 → 6. Phases 0 and 3 run alongside.

---

## Trade-offs (what was cut + why)

- **Cut: `session/prompt` health-ping as the default mechanism** (architect/simplifier/integration). It burns a turn or adds per-reuse latency; replaced by the free synchronous liveness check + `deposit`-time exit listener. The ping survives only as an opt-in `warm_pool_health_ping` flag (default off).
- **Cut: risk lens's 9 phases → 6.** Eviction (risk Phase 4) and the reuse path (risk Phase 3) merge into one Phase 4; config-wiring (risk Phase 7) folds into Phase 5. The distinct hazards are kept as sub-tests, not separate phases.
- **Cut: SQL `PERCENTILE_CONT` reader change** (architect) — the reader uses `percentileNearestRank`; the wrong approach would not compile.
- **Cut: `trust_mode`/`task_class` in the pool key** (all) — dispatch-level, would fragment the pool to zero reuse.
- **Cut: age-cap-as-key, cross-worker sharing, cross-restart persistence** — in-process singleton, worker crash = clean slate (eliminates the orphaned-session surface; this is desirable given the wedge history).
- **Deferred: `strictMcpConfig`/tool-schema trim** — orthogonal cold-path win, no sequencing dependency on the pool; land independently if Phase 6 shows `session/new` still dominates warm overhead.
- **Deferred: rollout beyond `codex-acp-fast`** — single-agent pilot until the crash-rate canary is clean.

## Open questions (need operator before implementation)

1. **`PENUMBRA_HANDOFF_ID` per-prompt injection (Phase 4 blocker).** Does penumbra-mcp's `session/prompt` handler read `_meta.penumbraHandoffId`, or only the `session/new` env (line 610)? If only env, a small penumbra-mcp change (accept per-prompt identity) is a prerequisite — otherwise warm dispatches mis-attribute to the first handoff's id in audit/memory. Must be inspected before reuse lands.
2. **Crash-guard soak window.** Phase 6's "≥1 week of stable `code:1` rate post-99b51e78" — confirm the soak has elapsed before enabling the flag, since the pool adds a new persistent-session surface for the wedge to bite.
3. **`maxEntries` for the pilot.** Default 3 supports concurrent dispatches per `(agent,cwd)`; if `codex-acp-fast` is strictly single-cwd/serial in the pilot, 1 is sufficient and cheaper (~50–100MB RAM/entry). Operator call on pilot concurrency expectations.
