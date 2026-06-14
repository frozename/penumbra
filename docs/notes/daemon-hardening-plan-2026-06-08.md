# Daemon Hardening + Observation/Usage Capture Restoration — Phased TDD Plan

_Produced 2026-06-08 via adversarial-plan (architect / simplifier / risk / integration → synthesizer). Builds on acute fix `6dc5da53` (gh-client async `Bun.spawn`). Do NOT redo that._

## Root cause (already diagnosed + acutely fixed)
The daemon's single-threaded bun event loop froze ~21s every ~30s. Cause: `gh-client.ts defaultExec` ran `gh` via **`Bun.spawnSync`** (synchronous, blocks the loop ~0.67s/call); `gh-task-sync` re-syncs all ~33 linked tasks each cycle (~33 × 0.67s ≈ 21s contiguous block). During each freeze ALL HTTP queued — dispatch capture observes (inflating post-session ~21–47s) and the maestro Stop hook's `/workflows/trigger` fetch ("stalled at 6/7"). Proven by t0_events.ingest_ts lagging event_ts 21.7s. Acute fix `6dc5da53` (verified: daemon HTTP max 80ms, dispatch gap 21s→113ms) switched to `Bun.spawn` + `await proc.exited` + concurrent stream reads.

## Open questions — RESOLVED (2026-06-08)
1. **t0 writer file** = `packages/core/src/writers/t0.ts` (NOT daemon/services). Phase 1.1 targets it.
2. **gh outbox is PERSISTED** (`gh_outbox` table, `packages/core/src/db/schema.ts:244`, indexed status+created_at / task_id+status). Survives restart → the startup-forced-reconcile (3.1) is a drift safety-net, not a durability requirement.
3. **Outbox enqueue lives in `packages/core/src/tasks/writer.ts`** — the "every status transition enqueues" audit (3.2) is an impl step; verify lease/complete/fail/cancel all push.
4. **capturePort default timeout = 2s** (start there; raise to 5s only if post-rollout undercounts appear).

---

## Landing order: Phase 1 (B+C+D, parallel, 1 commit) → Phase 2 (E) → Phase 3 (A)

| Phase | Parts | Files | Restart | Risk |
|---|---|---|---|---|
| 1 | B idempotent observations + C capturePort timeout + D lint guard | core/writers/t0.ts + routes/observations.ts; worker/capture-port.ts; scripts/lint/no-sync-exec.ts | daemon (tsc+kickstart) + worker on next dispatch | Low |
| 2 | E.1 poller dedup + E.2 opencode-db busy_timeout | usage-readers/poller.ts; opencode-db-reader.ts | none (worker) | Medium |
| 3 | A gh-task-sync outbox-driven + throttled reconcile | sweepers/gh-task-sync.ts; serve.ts; config | daemon (tsc+kickstart) | Med-High |

---

## Phase 1 — defense-in-depth (B + C + D, independent/parallel, one commit)

### 1.1 — t0Writer idempotent insert (B) — `packages/core/src/writers/t0.ts`
- Test `duplicate event_id returns existing id without throwing, row count stays 1`: write same event_id twice → `id2===id1`, no throw, count==1; distinct id still inserts. **Delete** any existing "duplicate fails loud" test.
- Impl: `INSERT INTO t0_events (…) ON CONFLICT(event_id) DO NOTHING RETURNING id`; if no row returned, recover via `SELECT id … WHERE event_id=?`. No migration (UNIQUE index exists).
- Add **`warn`-level conflict log** with `event_id` (+ handoff/source if reachable) — the only trip-wire for a genuine upstream collision once Phase 2 lands; must be greppable.
- `routes/observations.ts`: wrap write in try/catch; on residual SQLiteError return **200 with existing id** (not 500 / not 409 — poller treats as success, 409 would trip retry).
- Verify: `bun test <t0>.test.ts` + `bun test packages/daemon/src`. Restart: tsc --build + kickstart daemon.

### 1.2 — capturePort.close() bounded timeout (C) — `packages/agentchat/src/worker/capture-port.ts`
- Test `close() resolves within 2s even when in-flight requests stall` (inject a never-resolving send + `closeTimeoutMs:200` → close < 300ms, no throw).
- Impl: `await Promise.race([Promise.allSettled([...inFlight]), sleep(timeoutMs)])`, `timeoutMs = opts.closeTimeoutMs ?? 2_000`. Add `closed` guard (second close = no-op). On timeout log one warn (pending count), **never throw** (loop.ts must not crash on finalization).
- Verify: `bun test capture-port.test.ts`. Restart: none (worker, next dispatch). Accepted risk: a slow send past cutoff only undercounts client `stats.sent`; the event already went over HTTP + poller re-delivers idempotently.

### 1.3 — Lint: no synchronous subprocess in daemon (D) — `scripts/lint/no-sync-exec.ts` (new, ~30 LOC, mirror `no-raw-env.ts`)
- Test: flags `Bun.spawnSync(...)`, allows `await Bun.spawn(...)`, ignores out-of-scope paths.
- Impl: ban `\bBun\.spawnSync\b`, `\bexecSync\b`, `\bspawnSync\b`, and `child_process` import; scope `packages/daemon/src/**/*.ts` (exclude tests); exit 1 + file:line. Escape hatch `// lint-ignore: no-sync-exec <reason>`. Wire into root `lint`.
- Verify: `bun test no-sync-exec.test.ts` + `bun run lint` (0 violations — 6dc5da53 removed the only spawnSync). Restart: none.

---

## Phase 2 — usage-poller dedup + opencode busy_timeout (E) — sequential after Phase 1

### 2.1 — Poller duplicate event_id (E.1) — `packages/agentchat/src/usage-readers/poller.ts`
- **Decision: do NOT change the event_id derivation formula** (changing it re-emits historical rows under new ids). Fix = advance cursor only in the emit **success branch** (after ack), so a retry reuses the SAME id (Phase 1 dedupes silently). Add `lastEmittedIds` ring buffer (cap 256) as a secondary guard.
- Test: re-poll same cursor position → 0 new events; no dup ids; cursor strictly advances after rows read.
- Confirm `opencode-db-reader` returns `cursor.last_seen_time_created = max(time_created)` and `runReader` persists `cursors[reader.id]` before next tick.

### 2.2 — opencode-db-reader busy_timeout (E.2) — `packages/agentchat/src/usage-readers/opencode-db-reader.ts`
- **Decision: busy_timeout = 3000ms** (worker-side, well under 60s poll; waits rather than dropping data). **Stay read-only — do NOT promote the source DB to WAL (we don't own it).**
- Test: hold `BEGIN EXCLUSIVE` on a fixture, `reader.read(null)` resolves to empty deltas (no throw).
- Impl: after open, `db.run("PRAGMA busy_timeout = 3000")`. try/catch open+query; on lock/open failure return `{ cursor: prev ?? {last_seen_time_created:0}, usage_deltas: [], rate_limit_snapshots: [] }` + one warn; `finally db.close()`.
- Verify: `bun test poller.test.ts opencode-db-reader.test.ts`; live: dispatch codex job, daemon err log shows 0 UNIQUE-constraint over 5 min. Restart: none. No cursor-reset migration needed (formula unchanged).

---

## Phase 3 — gh-task-sync outbox-driven + throttled full-reconcile (A) — last

### 3.1 — Throttle full-reconcile — `packages/daemon/src/sweepers/gh-task-sync.ts`
- Test: with `fullReconcileIntervalMs:100`, 3 ticks 30s apart → `listLinkedTasks` called once; after interval → twice. Plus `on startup (lastFullReconcileAt=0) tick always runs a full reconcile`.
- Impl: closure `lastFullReconcileAt=0`, `fullReconcileIntervalMs` (default `300_000`). Always `await processGhOutbox()`; run `listLinkedTasks()` only when `now - lastFullReconcileAt >= interval`. Log `gh-task-sync.skip_full_reconcile` on outbox-only ticks. One immediate full reconcile on startup (drift safety; outbox is persisted so not a hard durability need).

### 3.2 — Outbox-driven per-task sync
- Test: only outbox tasks sync (not all linked); **concurrency cap ≤ 5** on the boot flush (33 pending → ≤5 concurrent gh calls).
- Impl: outbox primary; gate `listLinkedTasks()` behind 3.1's interval. **Semaphore/p-limit 5** + `Promise.allSettled` (avoid 33-concurrent-gh thunderstorm at boot). **Audit `packages/core/src/tasks/writer.ts` + routes/tasks.ts: every status transition (lease/complete/fail/cancel) enqueues to gh_outbox** — if any path is missed, add the push; do NOT narrow the reconcile until the gap is closed.
- Config (`serve.ts` + daemon config schema): `ghTaskSync.fullReconcileIntervalMs: 300000` (NEW), hot-reloadable via `daemon_reload_config`. No env var, no migration.
- Verify: `bun test gh-task-sync.test.ts`; tsc+kickstart; soak 5 min: outbox-only on most 30s ticks, `linked=N` only every 5 min, 0 gh 403/429, 0 UNIQUE-constraint, ingest lag <500ms median. **Accepted risk: GitHub→local pulls lag up to 5 min** (full-reconcile is the only pull path — slow it, don't remove it; tighter sync later = a GH webhook receiver, not a shorter interval).

## Cut for scope (deliberately)
event_id hash rewrite (re-emit hazard); extra config flags beyond the one yaml key; GH webhook receiver / durable in-memory queue (outbox already persisted); AST lint (regex suffices); capturePort retry (poller is the reliability layer); 409 on dedupe (200 avoids retry trip).
