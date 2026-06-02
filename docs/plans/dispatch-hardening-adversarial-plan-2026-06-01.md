# Dispatch-failure-recovery hardening — adversarial-plan

> Generated 2026-06-01 via inline-spec CC adversarial-plan (architect/simplifier/risk/integration -> synthesized). Run wf_68878a61-819.

I now have the load-bearing facts. Critical discovery that resolves a conflict across all four lenses: `WatchdogService.hasActiveWorker(timeoutMs)` is **global** — it returns whether ANY worker is fresh, not per-worker. The per-worker probe is `getStaleWorkers(timeoutMs): string[]` (the architect lens got this right; the other three assumed a non-existent `hasActiveWorker(worker_id, ...)`). Also: the sweeper takes plain options (no constructor/DI), the `dispatch.end` guard sits at line 116, and `resolveSweeperSqlCutoffMs` returns the min threshold (so it stays 5m because `health_check` is unchanged). I have everything needed.

---

# Dispatch-Hardening — Merged Phased TDD Plan

Synthesis of four lenses (architect, simplifier, risk, integration). Smaller than the sum: dropped speculative abstractions, kept simplifier scope, preserved risk/integration hazards. All changes additive, reversible, flag-gated where behavior changes. **Hard invariant preserved throughout: a worker with a stale heartbeat (no fresh heartbeat within `PENUMBRA_WORKER_HEARTBEAT_STALE_MS`, default 90s) is NEVER protected from sweep — fail-closed on every error/unknown/disabled path, and `max_alive_grace_ms` bounds even a perpetually-heartbeating-but-wedged worker.**

## Conflicts resolved (named + winner + one-line justification)

1. **Liveness probe API** — architect (`getStaleWorkers().includes(wid)`) vs simplifier/risk/integration (`hasActiveWorker(worker_id, ...)`). **Winner: architect**, because the codebase fact shows `hasActiveWorker(timeoutMs)` is global (any-worker) and `getStaleWorkers(timeoutMs): string[]` is the only per-worker probe — the other three's signature does not exist.
2. **Per-worker vs global liveness semantics** — A heartbeat is per-worker, but `getStaleWorkers` is the correct primitive. Winner: probe `!watchdog.getStaleWorkers(staleMs).includes(handoff.worker_id)`; a `worker_id` absent from the map is treated as not-alive (fail-closed), preserving the wedged-worker invariant.
3. **Test directory** — `__tests__/` (simplifier/risk/integration) vs `test/` (architect). **Winner: architect**, because the repo fact shows tests live in `packages/daemon/test/...`, not co-located `__tests__/`.
4. **Sweeper DI** — integration's `WatchdogService` constructor injection + per-instance `aliveSinceMs` Map vs architect/simplifier's plain injected `livenessCheck` fn. **Winner: architect/simplifier**, because `runStaleHandoffSweep` takes a plain opts object (no class), so injecting a fn keeps the change additive with zero structural churn; grace is measured from handoff `ts`, not a stateful first-deferral clock (one less mutable map to get wrong).
5. **`max_alive_grace_ms` default** — 10m (integration) vs 30m (architect) vs 120m (simplifier) vs `2*TTL` (risk). **Winner: 30m flat default**, because it comfortably clears the longest task TTL post-Phase-1 (90m would need a larger value, but grace is a *ceiling on top of* the watchdog's own 90s timeout — 30m is the documented last-resort, not the normal path; operators raise it for unusually long steps).
6. **dispatch-land idempotency probe** — `merge --is-ancestor` / `gh pr view` (simplifier/risk/integration) vs three-dot `diff --stat main...branch` empty-check + `beforeMain===afterMain` race guard (architect). **Winner: architect's diff + race guard**, because it needs no `gh` CLI latency and the second layer (`beforeMain===afterMain` after squash) is the only one that closes the concurrent-land race the other lenses missed.
7. **Autocommit deny rule** — broad `^\.[a-z]` hidden-dir regex + date-stamp regex (risk/integration) vs explicit `DENIED_SUBTREES` prefix list (architect). **Winner: architect's explicit subtree list (`docs/notes/`, `.antigravitycli/`, `.claude/`)**, because the broad regexes would silently block legitimate `.github/`/`.changeset/` and date-stamped docs that belong to a dispatch; explicit is reversible and auditable.
8. **Phase 0 harness** — risk's "write all 5 failing test files first" vs others' per-phase. **Winner: per-phase**, because TDD red→green per phase keeps each phase independently landable and reversible; a monolithic Phase 0 couples them.

## Gaps only one lens caught (kept)

- **TOCTOU: liveness-probe-vs-sweep** (risk/integration) — the probe and the `markFailed` write are not atomic; a worker can go stale between probe and write. **Resolved by ordering: probe is the *last* gate before the write, and the sweep is idempotent (cooldown map + `dispatch.end`-exists guard at line 116), so a stale-after-probe worker is simply caught on the next tick. The grace ceiling guarantees liveness can never indefinitely defer.** No lock needed.
- **Daemon-restart empties `lastHeartbeats`** (risk) — after restart the in-process map is empty, so `getStaleWorkers` reports every worker stale → sweep proceeds. This is fail-closed (today's behavior) and is documented, not fixed.
- **Concurrent `dispatch_land`** (architect/integration) — two land calls for the same branch: the `beforeMain===afterMain`-after-squash guard makes the loser a clean no-op (`already_landed`). Kept as Phase 2's second test.
- **`requeue-vs-claim`** (integration) — orphan-handoff-recovery requeue racing an in-flight agent completing → duplicate land. **Resolved by Phase 2 (idempotency) landing before Phase 1's liveness flag is enabled**, so any requeue-triggered duplicate land is already harmless.
- **Heartbeat IPC pileup** (integration) — `setInterval` can fire before the prior emit settles. **Resolved by swallowing emit errors inside the timer callback (emit never blocks the step) and clearing on `finally`.**
- **Empty-diff silently discards work** (integration/risk) — Phase 2's empty-diff no-op could mask an agent that wrote nothing. **Kept as a `warn`-level log; surfacing it as a distinct failed-dispatch status is an Open Question, not in scope.**

---

## Package boundaries

- `packages/daemon` — Phases 1, 2, 3 (`sweepers/`, `routes/`, `serve.ts`). Daemon restart.
- `packages/agentchat` — Phases 4, 5 (`worker/`). Worker restart.

No DB migrations in any phase.

---

## Phase 1 — Liveness-aware stale sweep + TTL uplift (daemon) — SEQUENTIAL, ship first

**Why first:** highest leverage — the liveness gate is the incident root cause; the TTL uplift is a zero-risk constant change that buys immediate slack. Bundled because both touch the sweeper and share one daemon restart. The liveness gate is flag-gated (default off) so this phase is a pure no-op until the flag is flipped.

### 1.1 Failing tests

File: `packages/daemon/test/sweepers/stale-handoff.test.ts` (extend existing suite)

**TTL uplift (thresholds):**
- `resolveStaleAfterMs(undefined) === 30*60_000` (was 15)
- `resolveStaleAfterMs("implement_small") === 60*60_000` (was 30)
- `resolveStaleAfterMs("implement_substantial") === 90*60_000` (was 60)
- `resolveStaleAfterMs("plan_refine") === 45*60_000` (was 30)
- `resolveStaleAfterMs("health_check") === 5*60_000` (unchanged — regression guard)
- `resolveStaleAfterMs("smoke_test") === 10*60_000` (unchanged — regression guard)
- `resolveSweeperSqlCutoffMs(resolveStaleAfterMs) === 5*60_000` (min stays `health_check` 5m — **do not** assert 10m)

**Liveness gate (inject `livenessCheck` into opts):**
- **off (default):** no `livenessCheck` in opts, handoff past TTL → `resolved` contains `handoff_id` (today's behavior preserved)
- **on, worker fresh, age < grace:** `livenessCheck: { isWorkerAlive: () => true }`, age 25m, `maxAliveGraceMs=30*60_000` → `candidates` contains id, `resolved` empty (deferred)
- **on, worker fresh, age > grace:** age 35m, grace 30m → `resolved` contains id (bounded grace; invariant)
- **on, worker stale/unknown:** `isWorkerAlive: () => false` → `resolved` contains id (fail-closed)
- **on, probe throws:** `isWorkerAlive: () => { throw }` → `resolved` contains id (fail-closed)
- **on, `handoff.worker_id` null:** → `resolved` contains id (no protection for null worker)

Run → RED.

### 1.2 Implementation

File: `packages/daemon/src/sweepers/stale-handoff-thresholds.ts`
- `DEFAULT_THRESHOLD_MS`: `15` → `30 * 60_000`
- `implement_substantial`: `60` → `90 * 60_000`; `implement_small`: `30` → `60 * 60_000`; `plan_refine`: `30` → `45 * 60_000`
- Leave `health_check` (5m), `smoke_test` (10m), `review_adversarial`/`docs_mechanical`/`debug_diagnose` untouched.

File: `packages/daemon/src/sweepers/stale-handoff.ts`
- Add to `StaleHandoffSweeperOpts`: `livenessCheck?: { isWorkerAlive: (worker_id: string) => boolean }; maxAliveGraceMs?: number;`
- Add `const DEFAULT_MAX_ALIVE_GRACE_MS = 30 * 60_000;`
- In the per-handoff loop, **after** `candidates.push(handoff_id)` and **before** the `classifyDispatchReliability` call (so the gate is the last decision before any write), insert:
  ```
  if (opts.livenessCheck && handoff.worker_id) {
    const graceMs = opts.maxAliveGraceMs ?? DEFAULT_MAX_ALIVE_GRACE_MS;
    const ageMs = nowMs - new Date(handoff.ts).getTime();
    if (ageMs <= graceMs) {
      let alive = false;
      try { alive = opts.livenessCheck.isWorkerAlive(handoff.worker_id); }
      catch { alive = false; } // fail-closed
      if (alive) { opts.log?.warn?.({ handoff_id }, "sweep deferred: worker alive"); continue; }
    }
  }
  ```
  (Confirm `handoff.worker_id` is selected — the loop's `handoff = services.handoffReader.get(handoff_id)` returns the full row; `worker_id` is on `HandoffRow`.)

File: `packages/daemon/src/serve.ts` (near line 1131, where `staleMs` is already read)
- `const staleMs = Number(process.env.PENUMBRA_WORKER_HEARTBEAT_STALE_MS) || 90000;` (already present — reuse)
- `const livenessEnabled = process.env.PENUMBRA_STALE_SWEEP_LIVENESS_CHECK === "true";`
- `const maxAliveGraceMs = Number(process.env.PENUMBRA_STALE_SWEEP_MAX_ALIVE_GRACE_MS) || undefined;`
- Wire into the `startStaleHandoffSweeper` opts:
  ```
  livenessCheck: livenessEnabled
    ? { isWorkerAlive: (wid) => !watchdog.getStaleWorkers(staleMs).includes(wid) }
    : undefined,
  maxAliveGraceMs,
  ```
  Note: a `worker_id` never seen by the watchdog is absent from `lastHeartbeats`, so it is neither in `getStaleWorkers` nor "alive" — `getStaleWorkers().includes(wid)` is `false`, making `!false === true` ("alive"). **This is a fail-OPEN bug for never-heartbeated workers.** Correct probe must require positive presence: `isWorkerAlive: (wid) => watchdog.hasRecentHeartbeat?.(wid, staleMs) ?? false`. Add a one-line public method to `WatchdogService`:
  ```
  hasRecentHeartbeat(worker_id: string, timeoutMs: number): boolean {
    const last = this.lastHeartbeats.get(worker_id);
    return last !== undefined && Date.now() - last <= timeoutMs;
  }
  ```
  This is the correct fail-closed per-worker primitive (the global `hasActiveWorker` and `getStaleWorkers` cannot express "this specific worker is fresh" without the unknown-worker fail-open hole).

### 1.3 Verify
```
bun test packages/daemon/test/sweepers/stale-handoff.test.ts
bun run typecheck    # from /Volumes/WorkSSD/repos/personal/penumbra
```

**Flag/schema delta:** `PENUMBRA_STALE_SWEEP_LIVENESS_CHECK` (default `false`), `PENUMBRA_STALE_SWEEP_MAX_ALIVE_GRACE_MS` (default 30m). TTL changes are code constants, no flag. **Restart:** daemon. Leave the flag `false` until Phase 2 is live.

---

## Phase 2 — dispatch-land idempotency guard (daemon) — INDEPENDENT of Phase 3/4/5; SEQUENTIAL-after-1 for safe rollout

**Why second:** prevents duplicate-land commits from retry/requeue storms. Must be live before the Phase 1 liveness flag is enabled so any requeue-vs-in-flight race is a clean no-op. Pure additive, no flag, no schema.

### 2.1 Failing tests

File: `packages/daemon/test/routes/dispatch-land.test.ts` (extend existing)

- **already merged (empty three-dot diff):** mock `runGit(["diff","--stat","main...<branch>"])` → exit 0, empty stdout → `executeLand` returns `{ ok: true, already_landed: true, commit_sha: <beforeMain sha> }`; assert no `["commit", ...]` runGit call made.
- **concurrent-land race:** `runGit` makes `rev-parse main` return the same SHA before and after squash+commit (staging empty) → returns `already_landed: true`.
- **normal land (regression):** diff non-empty → squash path runs → `ok: true` with `commit_sha`, `already_landed` undefined.

Run → RED.

### 2.2 Implementation

File: `packages/daemon/src/routes/dispatch-land.ts`
- Add `already_landed?: boolean` to `DispatchLandSuccess` (interface at line 35).
- In `executeLand` (line 368), after `beforeMain` resolves (line 404) and before `git checkout main` (line 417):
  ```
  const diffCheck = await deps.runGit(["diff", "--stat", `main...${branch}`]);
  if (diffCheck.code === 0 && diffCheck.stdout.trim().length === 0) {
    return { ok: true, commit_sha: beforeMain.stdout.trim(), message_subject: "(already landed)",
             branch_deleted: false, pr_closed: false, worktree_torn_down: false, already_landed: true };
  }
  ```
- After the `git commit` step (line 457) and `afterMain` resolve (line 482): if `beforeMain.stdout.trim() === afterMain.stdout.trim()`, return the same `already_landed: true` shape (closes the concurrent-land race). Match the exact `DispatchLandSuccess` field set the happy path returns.

### 2.3 Verify
```
bun test packages/daemon/test/routes/dispatch-land.test.ts
bun run typecheck
```

**Flag/schema delta:** none (always-on; strictly safer than a duplicate commit). **Restart:** daemon. **After this lands: flip `PENUMBRA_STALE_SWEEP_LIVENESS_CHECK=true`.**

---

## Phase 3 — Heartbeat emission during long agent steps (agentchat) — INDEPENDENT

**Why third:** defense-in-depth — keeps the liveness signal fresh so Phase 1's gate has data even for steps that emit no incidental events. Lower leverage than 1+2 (which already bound the window). Different package, different restart boundary.

### 3.1 Failing tests

File: `packages/agentchat/test/worker/heartbeat-emit.test.ts` (new)

- **emits during long step:** wrap a 300ms promise with `emitHeartbeatDuringStep(step, { ...opts, intervalMs: 100 })` → `emitHeartbeat` called ≥ 2 times before resolve.
- **emit failure swallowed:** `emitHeartbeat` always rejects → wrapped promise still resolves with original value.
- **timer cleared on resolve:** call count frozen after the step resolves (no post-resolution emits).
- **non-overlapping:** if an emit takes longer than `intervalMs`, no pileup (use re-arming `setTimeout` or guard a "busy" flag) — kept from integration's hazard.

Run → RED.

### 3.2 Implementation

File: `packages/agentchat/src/worker/heartbeat-emit.ts` (add export alongside existing `emitHeartbeat`)
```
export async function emitHeartbeatDuringStep<T>(
  step: Promise<T>, opts: EmitHeartbeatOpts & { intervalMs?: number },
): Promise<T> {
  const intervalMs = opts.intervalMs
    ?? Number(process.env.PENUMBRA_WORKER_HEARTBEAT_EMIT_MS) || 30_000;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;                 // non-overlapping (integration hazard)
    busy = true;
    emitHeartbeat(opts).catch(() => {}).finally(() => { busy = false; });
  }, intervalMs);
  try { return await step; } finally { clearInterval(timer); }
}
```
File: `packages/agentchat/src/worker/dispatcher.ts` — wrap the long-running `await adapter.run(...)` call-site with `emitHeartbeatDuringStep(...)`. Transparent: same return type, same error propagation.

### 3.3 Verify
```
bun test packages/agentchat/test/worker/heartbeat-emit.test.ts
bun run typecheck
```

**Flag/schema delta:** `PENUMBRA_WORKER_HEARTBEAT_EMIT_MS` (default 30s; half of the 90s stale timeout gives one missed-beat margin). **Restart:** agentchat worker.

---

## Phase 4 — wip-autocommit deny-list extension (agentchat) — INDEPENDENT

**Why last:** lowest leverage, purely protective, one function. Do last so a bad filter never blocks earlier phases.

### 4.1 Failing tests

File: `packages/agentchat/test/worker/autocommit-on-chain-end.test.ts` (extend existing)

- `filterAutocommitPaths(["docs/notes/maestro-continuation-2026-05-12-pm.md"]) === []`
- `filterAutocommitPaths(["docs/notes/adversarial-cycle3-followups-2026-05-16.md"]) === []`
- `filterAutocommitPaths([".antigravitycli/config.json"]) === []`
- `filterAutocommitPaths([".claude/scheduled_tasks.lock"]) === []`
- `filterAutocommitPaths(["docs/notes/gc-backup-2026-05-30/foo.md"]) === []`
- `filterAutocommitPaths(["packages/daemon/src/foo.ts"]) === ["packages/daemon/src/foo.ts"]` (regression)
- `filterAutocommitPaths(["docs/architecture/overview.md"]) === ["docs/architecture/overview.md"]` (non-notes doc still allowed — guards against over-broad deny)

Run → RED.

### 4.2 Implementation

File: `packages/agentchat/src/worker/autocommit-on-chain-end.ts` — extend `isDeniedPath` (line 55) with an explicit subtree prefix check (precedes the existing `DEFAULT_DENIED_PATTERNS`/extension checks):
```
const DENIED_SUBTREES = ["docs/notes/", ".antigravitycli/", ".claude/"];
// inside isDeniedPath, early:
if (DENIED_SUBTREES.some((p) => path.startsWith(p))) return true;
```
`filterAutocommitPaths` already composes `isAllowedPath(path) && !isDeniedPath(path)` (line 86) — no structural change.

### 4.3 Verify
```
bun test packages/agentchat/test/worker/autocommit-on-chain-end.test.ts
bun run typecheck
```

**Flag/schema delta:** none. **Restart:** agentchat worker.

---

## Sequencing summary

| Phase | Package | File(s) | Flag-gated | Restart | Independence |
|---|---|---|---|---|---|
| 1 — liveness gate + TTL | daemon | stale-handoff.ts, stale-handoff-thresholds.ts, serve.ts, watchdog.ts (+1 method) | liveness yes (default off); TTL no | daemon | first (sequential) |
| 2 — land idempotency | daemon | routes/dispatch-land.ts | no | daemon | after-1 for rollout; code-independent |
| 3 — mid-step heartbeat | agentchat | worker/heartbeat-emit.ts, worker/dispatcher.ts | no (interval env only) | worker | independent |
| 4 — autocommit deny-list | agentchat | worker/autocommit-on-chain-end.ts | no | worker | independent |

**Rollout order:** land Phase 1 (flag off) → land Phase 2 → flip `PENUMBRA_STALE_SWEEP_LIVENESS_CHECK=true` → land 3, 4 (parallelizable). Run `bun run typecheck` from the repo root after every phase.

---

## Trade-offs

- **TTL uplift widens the window a genuinely-wedged worker holds a slot.** Bounded by the Phase 1 liveness gate (only heartbeat-fresh workers get the longer window) and by the watchdog's own 90s timeout. Ship the gate and TTL together so the uplift is never the sole protection.
- **`max_alive_grace_ms` is a blunt 30m ceiling.** A perpetually-heartbeating-but-wedged worker is swept at 30m regardless. Intentional: the 90s watchdog should fire long before; grace is the last resort. Operators with >30m legitimate steps raise the env var.
- **Liveness probe is synchronous, per-handoff, per-tick.** `getStaleWorkers`/`hasRecentHeartbeat` are O(1)/O(N-workers) in-memory, not DB — negligible.
- **Daemon restart empties `lastHeartbeats`** → every worker reads stale → sweep proceeds (fail-closed = today's behavior). Documented, not fixed; alert on a spike of "sweep proceeded" right after restart if it ever matters.
- **Land idempotency empty-diff path is a clean no-op but can mask an agent that wrote nothing** — `warn`-level log is the only signal.
- **Mid-step heartbeat at 30s on a 90s timeout gives one missed-beat margin** — emit errors swallowed so a transient daemon restart never aborts the agent step.
- **Autocommit deny-list is filename-pattern brittle** — explicit subtree prefixes are auditable and reversible; a future `.noautocommit` marker file would be more robust.

## Open questions

1. **Empty-diff land status** — should a zero-diff land surface as a distinct `empty_diff` failed-dispatch status (so maestro re-dispatches with a stronger prompt) rather than a silent `already_landed` no-op? Out of scope here.
2. **`max_alive_grace_ms` per-task-type vs flat** — a flat 30m under-serves a legitimately 90m `implement_substantial`. Should grace scale with the resolved TTL (e.g. `2 × TTL`, capped)? Deferred — flat default + env override for now.
3. **`worker_id` provenance on older handoffs** — confirm every `dispatched` handoff row has a non-null `worker_id`; rows predating worker-id tracking will never be liveness-protected (correct fail-closed, but worth confirming none are perpetually in-flight).
4. **Heartbeat emit transport** — Phase 3 assumes `emitHeartbeat`'s existing transport reaches the same `WatchdogService.recordHeartbeat` the gate reads. Verify the worker's heartbeat POST lands in `lastHeartbeats` (via `routes/worker-heartbeat.ts` → `services.watchdog.recordHeartbeat`) before enabling the Phase 1 flag in production.
