# Worker hardening Tier 2 — phased TDD plan (GH #122)

Source spec: [`2026-05-20-worker-hardening-tier2.md`](./2026-05-20-worker-hardening-tier2.md). Synthesized from a 5-persona adversarial-plan fan-out on 2026-05-20 (`.penumbra/reviews/2026-05-20T05-27-37.142Z/synthesis.md`). Architect dispatch returned no artifacts; test-first timed out. Simplifier, risk, and integration personas converged.

## Architectural decisions adopted

| Question | Decision | Rationale |
|---|---|---|
| Orphan-state location | Additive columns on `handoffs`; **reuse existing `services.watchdog` for liveness** (see correction below) | No side-table for Tier 2; counters cover cap enforcement; `dispatch_events` provides audit trail |
| Retry policy | Auto-retry by default; `PENUMBRA_ORPHAN_HANDOFF_STRICT_MODE=1` for fail-fast | Tier 2 goal is survivability, not strict failure |
| Liveness detection | Existing watchdog + `heartbeat.received` events; **no new `worker_heartbeats` table** (see correction below) | Infra already in place |
| Dual-worker race | SQL CAS: `UPDATE … WHERE status='dispatched' AND worker_id=?` | Both risk and integration personas converged |
| Default cap | 3 | One transient bounce + one retry margin, still bounded |

## Plan corrections from open-question verification

The synthesis flagged 3 open questions; cheap verification before dispatch found:

1. **`workflow_run_id` is NOT persisted on `handoffs`** today. It flows through `chain_start` as a one-time `services.workflowRuns.verify(input.workflow_run_id)` check (`packages/daemon/src/routes/chains.ts:136`), but no column carries it on the row. **→ Phase 1.1 MUST add `handoffs.workflow_run_id`**, and Phase 2.1 MUST thread it through `createApproved`.

2. **A `POST /worker/heartbeat` route + watchdog already exist** (`packages/daemon/src/routes/worker-heartbeat.ts`; `services.watchdog.recordHeartbeat()`). Workers emit heartbeats via `packages/agentchat/src/worker/heartbeat-emit.ts`; both `heartbeat.received` and `heartbeat.sent` are recognized event kinds.  **→ Phase 1.1 does NOT add `worker_heartbeats` table. Phase 3.1 does NOT add a heartbeat route.** Instead, Phase 3.1 reads liveness from `services.watchdog` (or its in-memory map; verify exact API before dispatching 3.1).

3. **Test harness kill semantics**: synthesizer asked whether a literal `SIGKILL` is needed or a synthetic stale-heartbeat suffices. **Decision deferred to Phase 5.1**: start with a synthetic stale-heartbeat (deterministic, no process management); if that doesn't reproduce the real-world race, escalate to a real subprocess kill via the in-process daemon harness.

## Phase graph

```
1.1 → (2.1 ‖ 2.2) → (3.1 ‖ 3.2) → 4.1 → 5.1
```

---

## Phase 1 — Schema contract

### Task 1.1 — Additive schema primitives

```yaml meta
id: '1.1'
files:
  - packages/core/src/db/schema.ts
  - packages/core/src/schemas/handoff.ts
  - packages/core/test/db/schema-dispatch-recovery.test.ts
  - packages/core/test/schemas/handoff.test.ts
file_scope: extend-shared
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

**Failing tests:**
- `schema-dispatch-recovery.test.ts`: seed legacy DB, apply migration, assert new columns exist on `handoffs`:
  - `dispatch_attempts` (INTEGER NOT NULL DEFAULT 0)
  - `max_dispatch_attempts` (INTEGER NOT NULL DEFAULT 3)
  - `last_dispatch_started_at` (TEXT nullable)
  - `workflow_run_id` (TEXT nullable)
  - index `handoffs(status, worker_id, ts)`
- `handoff.test.ts`: `HandoffRowSchema` exposes the four new fields.

**Implementation:**
- Add columns via `addColumnIfMissing` in `schema.ts` (additive block, per memory `[[feedback_schema_migration_index_column_ordering.md]]` ordering rule).
- Bump `SCHEMA_VERSION`.
- No new tables. No destructive backfill.

**Verify:** `bun test packages/core/test/db/schema-dispatch-recovery.test.ts && bun test packages/core/test/schemas/handoff.test.ts && bun run typecheck`

**Restart needed:** daemon kickstart to apply migration.

---

## Phase 2 — Core writer/reader semantics

### Task 2.1 — Attempt-aware claim + attempt cap

```yaml meta
id: '2.1'
files:
  - packages/core/src/writers/handoff.ts
  - packages/core/test/writers/handoff.test.ts
file_scope: extend-shared
depends_on: ['1.1']
parallel_with: ['2.2']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

**Failing tests:**
- `claimDispatch` atomically increments `dispatch_attempts` and stamps `last_dispatch_started_at`.
- Claim is rejected (returns null) when `dispatch_attempts >= max_dispatch_attempts`.
- `createApproved` accepts and persists `workflow_run_id` and `max_dispatch_attempts` (default 3).

**Implementation:**
- Update `claimDispatch` SQL: `SET status='dispatched', worker_id=?, dispatch_attempts = dispatch_attempts+1, last_dispatch_started_at=? WHERE id=? AND status='approved' AND dispatch_attempts < max_dispatch_attempts`.
- Thread `workflow_run_id` and optional `max_dispatch_attempts` into `createApproved`.

**Verify:** `bun test packages/core/test/writers/handoff.test.ts`

**Failure modes to watch post-merge:** claim-route 409 spike (cap exhaustion); type drift between DB row and schema.

---

### Task 2.2 — Orphan requeue and exhaustion primitives

```yaml meta
id: '2.2'
files:
  - packages/core/src/writers/handoff.ts
  - packages/core/src/readers/handoff.ts
  - packages/core/test/writers/handoff-recovery.test.ts
  - packages/core/test/readers/handoff-recovery.test.ts
file_scope: extend-shared
depends_on: ['1.1']
parallel_with: ['2.1']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

**Failing tests:**
- `requeueOrphanedDispatch(handoffId, deadWorkerId)`: CAS reclaim transitions `dispatched → approved`, clears `worker_id`; returns true on success, false if row already moved.
- Second call on the same row returns false (race safety).
- `failOrphanedDispatchExhausted(handoffId, deadWorkerId)`: transitions to terminal `failed` with `resolution_reason='failed_worker_restart: attempts exhausted'`.
- `listOrphanedDispatches(staleWorkerIds)`: returns `dispatched` rows whose `worker_id` is in the stale set.

**Implementation:**
- Add three methods to writer/reader. Both CAS writes keyed on `status='dispatched' AND worker_id=?`.
- No changes to existing claim or terminal paths.

**Verify:** `bun test packages/core/test/writers/handoff-recovery.test.ts && bun test packages/core/test/readers/handoff-recovery.test.ts`

---

## Phase 3 — Daemon recovery engine + telemetry

### Task 3.1 — Orphan-recovery service hooked into daemon loop

```yaml meta
id: '3.1'
files:
  - packages/daemon/src/services/orphan-handoff-recovery.ts
  - packages/daemon/src/serve.ts
  - packages/daemon/test/services/orphan-handoff-recovery.test.ts
file_scope: extend-shared
depends_on: ['2.1', '2.2']
parallel_with: ['3.2']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: bootstrap-touching
```

**Note vs synthesis**: no new heartbeat route; reuse the existing `services.watchdog` liveness map.

**Failing tests:**
- Recovery service with one stale worker (`watchdog` reports `last_heartbeat_at < now - PENUMBRA_WORKER_HEARTBEAT_STALE_MS`) + one dispatched handoff on that worker:
  - attempt < max → requeues, returns `{requeued:1, exhausted:0}`.
  - attempt == max → exhausts, returns `{requeued:0, exhausted:1}`.
  - CAS race: two concurrent recovery calls → exactly one wins.
  - Active worker heartbeat within stale window → skipped.
- `serve.ts` registers the periodic recovery loop alongside existing sweepers (`stale-handoff`, `orphan-lanes`, `worktree.gc`).

**Implementation:**
- Service queries `services.watchdog.listStaleWorkers(now - staleMs)` (verify exact API; add helper if missing).
- For each stale worker, call `listOrphanedDispatches([worker_id])`, then dispatch each row to `requeueOrphanedDispatch` (under cap) or `failOrphanedDispatchExhausted` (cap hit).
- Wire into `serve.ts` as a periodic task at `PENUMBRA_ORPHAN_HANDOFF_RECOVERY_INTERVAL_MS` (default 15000).

**Env knobs activated:**
- `PENUMBRA_WORKER_HEARTBEAT_STALE_MS` (default 90000)
- `PENUMBRA_ORPHAN_HANDOFF_RECOVERY_INTERVAL_MS` (default 15000; set 0 to disable for rollback)
- `PENUMBRA_ORPHAN_HANDOFF_RECOVERY_BATCH` (default 100)
- `PENUMBRA_ORPHAN_HANDOFF_STRICT_MODE` (default 0; 1 = fail-fast, skip auto-retry)
- `PENUMBRA_HANDOFF_MAX_DISPATCH_ATTEMPTS_DEFAULT` (default 3)

**Rollback:** `PENUMBRA_ORPHAN_HANDOFF_RECOVERY_INTERVAL_MS=0`.
**Restart needed:** daemon kickstart.

---

### Task 3.2 — Recovery telemetry

```yaml meta
id: '3.2'
files:
  - packages/core/src/services/dispatch-event-log.ts
  - packages/api-contract/src/dispatch-events.ts
  - packages/daemon/test/routes/dispatch-events.test.ts
file_scope: extend-shared
depends_on: ['1.1', '2.2']
parallel_with: ['3.1']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Failing tests:**
- New event kinds `worker.recovery.requeued` and `worker.recovery.exhausted` accepted and serialized.
- Each event carries `{attempt, max_attempts, from_worker_id, handoff_id}` in meta.
- `/dispatch-events` route round-trips both new kinds.

**Implementation:** add event-kind enum values and meta shape in both `dispatch-event-log.ts` and `api-contract/dispatch-events.ts` (mirror is required — see memory on cross-package alignment). No schema migration.

**Verify:** `bun test packages/daemon/test/routes/dispatch-events.test.ts`

---

## Phase 4 — Worker boot reconcile

### Task 4.1 — Boot calls dispatch-orphan recovery

```yaml meta
id: '4.1'
files:
  - packages/agentchat/src/penumbra-client.ts
  - packages/agentchat/src/worker/boot-reconcile.ts
  - packages/agentchat/bin/agentchat-worker.ts
  - packages/agentchat/test/worker/boot-reconcile.test.ts
file_scope: extend-shared
depends_on: ['3.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

**Failing tests:**
- Worker boot reconcile posts a heartbeat (existing route) and then triggers a recovery sweep (new client method).
- Retry-once with 3s timeout; failures log and continue boot rather than crash.

**Implementation:**
- Add `reconcileDispatchOrphans(workerId)` client method to `penumbra-client.ts` (calls `POST /worker/reconcile-orphans` or equivalent service-direct invocation).
- Extend `boot-reconcile.ts` to call it after heartbeat registration. Order: heartbeat → long-lived orphans → dispatch orphans.

**Verify:** `bun test packages/agentchat/test/worker/boot-reconcile.test.ts`

**Restart needed:** worker kickstart.

---

## Phase 5 — Acceptance contract

### Task 5.1 — Kill mid-flight, restart, recover, cap

```yaml meta
id: '5.1'
files:
  - packages/agentchat/test/integration/worker-restart-recovery.test.ts
  - packages/agentchat/test/helpers/in-process-daemon.ts
file_scope: new
depends_on: ['4.1', '3.2']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: bootstrap-touching
```

**Failing test (contract):**
1. Start N persona-style dispatches (`dispatch_kind='workflow'`); confirm M enter `dispatched`.
2. Simulate worker death — first try a synthetic stale-heartbeat (faster the watchdog tick to mark the worker stale). If that doesn't reproduce a real race, fall back to a real SIGKILL via the in-process harness.
3. Start replacement worker against the same storage root.
4. Assert every orphaned handoff ends as: auto-retried to terminal (`completed|failed`) OR terminal `failed` with `resolution_reason` containing `failed_worker_restart`.
5. Assert no `dispatched` row remains pinned to dead `worker_id`.
6. Assert a persistently-failing mock adapter stops at `max_attempts` (does not retry indefinitely).
7. Assert `workflow_run_id` on recovered rows is unchanged.

**Implementation:** smallest possible harness support — kill/respawn helpers in `in-process-daemon.ts`; one mock-fail persona + one normal persona for determinism. No new orchestration abstractions.

**Verify:**
```
bun test packages/agentchat/test/integration/worker-restart-recovery.test.ts
bun test packages/daemon/test/routes/workflows.test.ts
bun test packages/daemon/test/routes/chains.test.ts
bun run typecheck
```

**Restart needed:** daemon + worker kickstart for the live staging drill afterwards.

---

## Service restart matrix

| Phase | Change | Restart needed |
|---|---|---|
| 1 | migration | daemon kickstart |
| 2 | core writers/readers | none |
| 3 | daemon service | daemon kickstart |
| 4 | worker boot path | worker kickstart |
| 5 | integration test only | daemon + worker kickstart for staging drill |

## Staging rollout

After Phase 5 passes CI:
1. Deploy daemon (applies migration on boot).
2. Kickstart worker.
3. Live drill: start an adversarial-review fan-out (6–8 personas), SIGKILL worker mid-flight, confirm synthesis completes and no rows stuck in `dispatched`.
4. Watch 24h:
   - `SELECT COUNT(*) FROM handoffs WHERE status='dispatched' AND worker_id IS NOT NULL;` → drains to 0 within one stale window.
   - Event rate for `worker.recovery.requeued` and `worker.recovery.exhausted`.
   - Cap-exhaust failures: `SELECT COUNT(*) FROM handoffs WHERE resolution_reason LIKE 'failed_worker_restart%'`.

## Deferred to Tier 3

- `handoff_attempts` side-table for per-attempt history.
- Per-persona retry caps (operator config).
- Upstream `worker.restarted` events surfaced to `workflow_run` consumers (Tier 3 polish; not needed for survivability).
- `dispatch-reliability.ts` extension (event kinds already cover operator needs).
