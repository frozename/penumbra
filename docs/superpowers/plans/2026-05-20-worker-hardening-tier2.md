# Worker Hardening Tier 2 — Dispatch Checkpoint + Worker-Restart Recovery

> **For agentic workers:** REQUIRED SUB-SKILL: Use `penumbra:executing-plans` or
> `penumbra:subagent-driven-development` to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-flight dispatches survive a routine worker bounce — never silently
dropped. When the `WatchdogService` detects a dead worker it currently calls
`markFailed` immediately, losing all the worker's in-flight handoffs. This plan
adds a per-handoff retry counter so the watchdog resets orphaned dispatches for
the replacement worker to pick up, and only fails them after `max_attempts` is
exhausted.

**Root cause:** `WatchdogService.tick()` in
`packages/daemon/src/services/watchdog.ts:61-96` calls
`handoffWriter.markFailed` unconditionally — no attempt counter, no retry.

**Boundary change (additive only):**

- `handoffs` gets two new columns: `attempt_count` (default 1), `max_attempts` (default 3).
- `HandoffWriter` gets a new `resetForRetry()` method (CAS: dispatched → approved, clears `worker_id`, increments `attempt_count`).
- `WatchdogService.tick()` branches: below cap → `resetForRetry` + `watchdog.retry` event; at cap → `markFailed(reason: 'worker_restart_attempts_exhausted')`.

**Why `approved` not `pending` on retry:** `claimDispatch` requires `status IN ('approved','redirected')`; the worker's event source surfaces `approved` rows. Resetting to `approved` lets the replacement worker claim it on the next poll cycle without a separate approve step.

## Phase 1 — Schema: `attempt_count`, `max_attempts`, dispatched-by-worker index

```
Dispatch graph: 1.1
```

### Task 1.1 — Schema migration + contract tests

```yaml meta
id: "1.1"
files:
  - packages/core/src/db/schema.ts
  - packages/core/test/db/schema.test.ts
file_scope: modify-existing
depends_on: []
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: small
risk_class: schema-aware
```

- [ ] **Step 1: Write the failing tests**

In `packages/core/test/db/schema.test.ts`, add after the existing tests:

```ts
test('handoffs table has attempt_count and max_attempts columns after migration', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const cols = db
    .query<{ name: string }, []>('PRAGMA table_info(handoffs)')
    .all()
    .map((c) => c.name);
  expect(cols).toContain('attempt_count');
  expect(cols).toContain('max_attempts');
});

test('fresh handoff row has attempt_count=1 and max_attempts=3 by default', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  db.exec(
    `INSERT INTO handoffs (handoff_id,ts,project_id,conversation_id,from_agent,to_agent,message,status)
     VALUES ('h-schema-1','2026-05-20T00:00:00Z',null,'c1','a','b','m','pending')`,
  );
  const row = db
    .query<{ attempt_count: number; max_attempts: number }, []>(
      `SELECT attempt_count, max_attempts FROM handoffs WHERE handoff_id='h-schema-1'`,
    )
    .get();
  expect(row?.attempt_count).toBe(1);
  expect(row?.max_attempts).toBe(3);
});

test('SCHEMA_VERSION is 18', () => {
  expect(SCHEMA_VERSION).toBe(18);
});

test('handoffs_dispatched_by_worker index exists after migration', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const idx = db
    .query<{ name: string }, [string]>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name=?`,
    )
    .get('handoffs_dispatched_by_worker');
  expect(idx).not.toBeNull();
});
```

- [ ] **Step 2: Verify the tests fail**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra
bun test packages/core/test/db/schema.test.ts
```

Expected: 4 new test failures (columns missing, version still 17, index missing).

- [ ] **Step 3: Implement the migration**

In `packages/core/src/db/schema.ts`:

1. Bump `SCHEMA_VERSION = 18`.
2. Add to the `CREATE TABLE IF NOT EXISTS handoffs` block (inside the initial
   CREATE — the two new columns will be populated by `addColumnIfMissing` on
   existing DBs):
   ```sql
   attempt_count  INTEGER NOT NULL DEFAULT 1,
   max_attempts   INTEGER NOT NULL DEFAULT 3
   ```
3. Add to the additive migration block (after the existing
   `addColumnIfMissing(db, 'handoffs', 'root_handoff_id', ...)` group):
   ```ts
   addColumnIfMissing(db, 'handoffs', 'attempt_count', 'INTEGER NOT NULL DEFAULT 1');
   addColumnIfMissing(db, 'handoffs', 'max_attempts',  'INTEGER NOT NULL DEFAULT 3');
   db.exec(
     `CREATE INDEX IF NOT EXISTS handoffs_dispatched_by_worker
        ON handoffs(worker_id, status) WHERE status='dispatched'`,
   );
   ```

- [ ] **Step 4: Verify the tests pass**

```bash
bun test packages/core/test/db/schema.test.ts
bun run typecheck   # from packages/core
```

Integration: `addColumnIfMissing` is idempotent on existing DBs; fresh DBs get
the columns inline. Run `bun test packages/core` to confirm no regressions. The
daemon must be restarted after deploying this schema change (existing behaviour:
HTTP 400s on stale daemon).

## Phase 2 — `HandoffWriter.resetForRetry()` with CAS semantics

```
Dispatch graph: 2.1
```

### Task 2.1 — Add resetForRetry to HandoffWriter + unit tests

```yaml meta
id: "2.1"
files:
  - packages/core/src/writers/handoff.ts
  - packages/core/test/writers/handoff.test.ts
file_scope: modify-existing
depends_on: ["1.1"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: small
risk_class: paste-ready
```

- [ ] **Step 1: Write the failing tests**

In `packages/core/test/writers/handoff.test.ts`, add:

```ts
test('resetForRetry resets dispatched → approved, clears worker_id, increments attempt_count', () => {
  const id = 'h-retry-1';
  db.exec(
    `INSERT INTO handoffs (handoff_id,ts,project_id,conversation_id,from_agent,to_agent,message,status,worker_id,attempt_count,max_attempts)
     VALUES ('${id}','2026-05-20T00:00Z',null,'conv-r1','a','b','msg','dispatched','w-1',1,3)`,
  );

  const result = writer.resetForRetry(id, 'w-1');

  expect(result).toBe(true);
  const row = db
    .query<{ status: string; worker_id: string | null; attempt_count: number }, []>(
      `SELECT status, worker_id, attempt_count FROM handoffs WHERE handoff_id='${id}'`,
    )
    .get();
  expect(row?.status).toBe('approved');
  expect(row?.worker_id).toBeNull();
  expect(row?.attempt_count).toBe(2);
});

test('resetForRetry returns false when worker_id does not match (CAS miss)', () => {
  const id = 'h-retry-2';
  db.exec(
    `INSERT INTO handoffs (handoff_id,ts,project_id,conversation_id,from_agent,to_agent,message,status,worker_id,attempt_count,max_attempts)
     VALUES ('${id}','2026-05-20T00:00Z',null,'conv-r2','a','b','msg','dispatched','w-1',1,3)`,
  );

  const result = writer.resetForRetry(id, 'w-OTHER'); // wrong worker

  expect(result).toBe(false);
  const row = db
    .query<{ status: string; worker_id: string }, []>(
      `SELECT status, worker_id FROM handoffs WHERE handoff_id='${id}'`,
    )
    .get();
  expect(row?.status).toBe('dispatched'); // unchanged
  expect(row?.worker_id).toBe('w-1');     // unchanged
});

test('resetForRetry returns false when handoff is already terminal', () => {
  const id = 'h-retry-3';
  db.exec(
    `INSERT INTO handoffs (handoff_id,ts,project_id,conversation_id,from_agent,to_agent,message,status,worker_id,attempt_count,max_attempts)
     VALUES ('${id}','2026-05-20T00:00Z',null,'conv-r3','a','b','msg','completed','w-1',2,3)`,
  );

  const result = writer.resetForRetry(id, 'w-1');

  expect(result).toBe(false);
});
```

- [ ] **Step 2: Verify the tests fail**

```bash
bun test packages/core/test/writers/handoff.test.ts
```

Expected: 3 new failures (`resetForRetry` does not exist yet).

- [ ] **Step 3: Implement resetForRetry**

In `packages/core/src/writers/handoff.ts`, add after `claimDispatch`:

```ts
/**
 * CAS reset: transitions a dispatched handoff back to approved iff the current
 * worker_id matches expected_worker_id. Increments attempt_count and clears
 * worker_id so the replacement worker can claim it on the next poll cycle.
 * Returns true if updated, false if the CAS missed (row already claimed by
 * another worker, or already in terminal state).
 */
resetForRetry(handoff_id: string, expected_worker_id: string): boolean {
  const changes = this.db
    .query<unknown, [string, string]>(
      `UPDATE handoffs
          SET status='approved', worker_id=NULL, attempt_count=attempt_count+1
        WHERE handoff_id=? AND status='dispatched' AND worker_id=?`,
    )
    .run(handoff_id, expected_worker_id);
  return changes.changes > 0;
}
```

- [ ] **Step 4: Verify the tests pass**

```bash
bun test packages/core/test/writers/handoff.test.ts
bun run typecheck   # from packages/core
bun test packages/core
```

Integration: Additive method — no callers yet, no regressions expected. Merge when green.

## Phase 3 — WatchdogService retry/fail branching

```
Dispatch graph: 3.1
```

### Task 3.1 — Extend WatchdogService.tick() + update existing tests

```yaml meta
id: "3.1"
files:
  - packages/daemon/src/services/watchdog.ts
  - packages/daemon/test/services/watchdog.test.ts
file_scope: modify-existing
depends_on: ["2.1"]
parallel_with: []
preferred_agent: oc-deepseek-v4-pro
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

- [ ] **Step 1: Write the failing tests**

In `packages/daemon/test/services/watchdog.test.ts`, add a `createAndClaimHandoff`
helper that wraps the create/approve/claim route chain, then add:

```ts
// helper
async function createAndClaimHandoff(
  services: Services,
  worker_id: string,
  conversation_id: string,
): Promise<{ handoff_id: string }> {
  const c = await (
    await handoffsCreateRoute(
      new Request('http://x', {
        method: 'POST',
        body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id, triggered_by_event_id: 'e' }),
      }),
      services,
    )
  ).json();
  await handoffsApproveRoute(new Request('http://x', { method: 'POST', body: '{}' }), c.handoff_id, services);
  await handoffsClaimRoute(
    new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id }) }),
    c.handoff_id,
    services,
  );
  return c;
}

test('WatchdogService resets dispatched handoff to approved if attempt_count < max_attempts', async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;

  const c = await createAndClaimHandoff(services, 'w-retry', 'conv-wr1');

  watchdog.recordHeartbeat('w-retry');
  (watchdog as any).lastHeartbeats.set('w-retry', Date.now() - 70_000);
  await watchdog.tick();

  const row = services.handoffReader.get(c.handoff_id);
  expect(row?.status).toBe('approved');
  expect(row?.attempt_count).toBe(2);
  expect(row?.worker_id).toBeNull();

  const events = services.dispatchEventLog.listByHandoff(c.handoff_id);
  expect(events.some((e) => e.kind === 'watchdog.retry')).toBe(true);
  expect(events.some((e) => e.kind === 'watchdog.auto_fail')).toBe(false);
});

test('WatchdogService marks handoff failed with worker_restart_attempts_exhausted when attempt_count = max_attempts', async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;

  const c = await createAndClaimHandoff(services, 'w-exhaust', 'conv-we1');
  // Force attempt_count to cap
  services.db.exec(
    `UPDATE handoffs SET attempt_count=3, max_attempts=3 WHERE handoff_id='${c.handoff_id}'`,
  );

  watchdog.recordHeartbeat('w-exhaust');
  (watchdog as any).lastHeartbeats.set('w-exhaust', Date.now() - 70_000);
  await watchdog.tick();

  const row = services.handoffReader.get(c.handoff_id);
  expect(row?.status).toBe('failed');
  expect(row?.resolution_reason).toBe('worker_restart_attempts_exhausted');

  const events = services.dispatchEventLog.listByHandoff(c.handoff_id);
  expect(events.some((e) => e.kind === 'watchdog.auto_fail')).toBe(true);
});
```

Also **update the two existing watchdog tests** to pre-set `attempt_count=max_attempts`
so they continue to exercise the fail path (they currently expect `status='failed'`
and `resolution_reason='worker timeout'`):

- Add `services.db.exec("UPDATE handoffs SET attempt_count=3, max_attempts=3 WHERE handoff_id=?", ...)` after each `handoffsClaimRoute` call in the two existing tests.
- Update `resolution_reason` assertion from `'worker timeout'` to `'worker_restart_attempts_exhausted'`.
- Update `error_summary` in the notification test from `'worker timeout'` to `'worker_restart_attempts_exhausted'`.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test packages/daemon/test/services/watchdog.test.ts
```

Expected: 2 new tests fail; 2 existing tests fail on the assertion mismatch.

- [ ] **Step 3: Implement the branching in WatchdogService.tick()**

In `packages/daemon/src/services/watchdog.ts`, replace the `affectedHandoffs` query
and the for-loop body with:

```ts
const affectedHandoffs = this.services.db
  .query<
    {
      handoff_id: string;
      conversation_id: string;
      project_id: string | null;
      to_agent: string | null;
      attempt_count: number;
      max_attempts: number;
    },
    [string]
  >(
    `SELECT handoff_id, conversation_id, project_id, to_agent, attempt_count, max_attempts
       FROM handoffs
      WHERE worker_id=? AND status='dispatched'`,
  )
  .all(worker_id);

for (const {
  handoff_id,
  conversation_id,
  project_id,
  to_agent,
  attempt_count,
  max_attempts,
} of affectedHandoffs) {
  if (attempt_count < max_attempts) {
    // Reset to approved so the replacement worker can claim it immediately.
    const reset = this.services.handoffWriter.resetForRetry(handoff_id, worker_id);
    if (reset) {
      this.services.dispatchEventLog.record({
        handoff_id,
        worker_id,
        source: 'daemon',
        kind: 'watchdog.retry',
        ts: tickTs,
        meta: {
          worker_id,
          attempt_count: attempt_count + 1,
          max_attempts,
          ms_since_heartbeat: now - lastSeen,
        },
      });
    }
  } else {
    // Attempts exhausted — surface as terminal failure.
    this.services.handoffWriter.markFailed(handoff_id, {
      reason: 'worker_restart_attempts_exhausted',
      ts: tickTs,
      resolved_by: 'watchdog',
    });
    this.services.dispatchEventLog.record({
      handoff_id,
      worker_id,
      source: 'daemon',
      kind: 'watchdog.auto_fail',
      ts: tickTs,
      meta: {
        worker_id,
        attempt_count,
        max_attempts,
        ms_since_heartbeat: now - lastSeen,
      },
    });

    this.emitFailureNotification({
      kind: 'watchdog_failure',
      worker_id,
      handoff_id,
      conversation_id,
      project_id,
      agent: to_agent,
      error_summary: 'worker_restart_attempts_exhausted',
    });

    this.services.conversationStream.emit(conversation_id, {
      type: 'chain-end',
      chain_id: conversation_id,
      reason: 'error',
    });
  }
}
```

- [ ] **Step 4: Verify all watchdog tests pass**

```bash
bun test packages/daemon/test/services/watchdog.test.ts
bun run typecheck   # from packages/daemon
```

Integration: Run `bun test packages/daemon` to confirm no other regressions. The
daemon must be restarted after deploying (schema change from Phase 1 + code change).

## Phase 4 — Acceptance: 3-bounce cycle test

```
Dispatch graph: 4.1
```

### Task 4.1 — Multi-bounce acceptance test

```yaml meta
id: "4.1"
files:
  - packages/daemon/test/services/watchdog-retry-acceptance.test.ts
file_scope: new
depends_on: ["3.1"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: small
risk_class: paste-ready
```

This test verifies all six acceptance criteria from the spec.

- [ ] **Step 1: Write the acceptance test**

Create `packages/daemon/test/services/watchdog-retry-acceptance.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { WatchdogService } from '../../src/services/watchdog.js';
import {
  handoffsCreateRoute,
  handoffsApproveRoute,
  handoffsClaimRoute,
} from '../../src/routes/handoffs.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/sqlite3.dylib');
  }
} catch { /* already loaded */ }

function tempServices(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/watchdog-acceptance-test',
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-05-20T00:00:00Z'),
    uuid: (() => { let n = 0; return () => `ev-${++n}`; })(),
  });
}

async function createAndClaim(
  services: Services,
  worker_id: string,
  conv: string,
): Promise<{ handoff_id: string }> {
  const c = await (await handoffsCreateRoute(
    new Request('http://x', { method: 'POST', body: JSON.stringify({
      from: 'maestro', to: 'codex-acp-fast', message: 'review persona A',
      conversation_id: conv, triggered_by_event_id: `trigger-${conv}`,
    }) }),
    services,
  )).json();
  await handoffsApproveRoute(new Request('http://x', { method: 'POST', body: '{}' }), c.handoff_id, services);
  await handoffsClaimRoute(
    new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id }) }),
    c.handoff_id, services,
  );
  return c;
}

test('acceptance: 3 handoffs survive 2 worker bounces and fail on the 3rd (max_attempts=3)', async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;

  // Criterion 1: N=3 dispatches from a fan-out
  const h1 = await createAndClaim(services, 'w-a', 'conv-acc-1');
  const h2 = await createAndClaim(services, 'w-a', 'conv-acc-2');
  const h3 = await createAndClaim(services, 'w-a', 'conv-acc-3');
  const handoff_ids = [h1.handoff_id, h2.handoff_id, h3.handoff_id];

  // ── Bounce 1: worker-a dies ──
  // Criterion 2: SIGKILL modelled by setting heartbeat stale
  watchdog.recordHeartbeat('w-a');
  (watchdog as any).lastHeartbeats.set('w-a', Date.now() - 70_000);
  await watchdog.tick();

  // Criterion 4: orphaned dispatches surface as approved (retry), not failed
  for (const hid of handoff_ids) {
    const row = services.handoffReader.get(hid);
    expect(row?.status).toBe('approved');
    expect(row?.attempt_count).toBe(2);
    expect(row?.worker_id).toBeNull();
  }
  // Criterion 5: no dispatched rows remain pinned to dead worker
  const stuck1 = services.db
    .query<{ n: number }, []>(`SELECT count(*) AS n FROM handoffs WHERE status='dispatched' AND worker_id='w-a'`)
    .get();
  expect(stuck1?.n).toBe(0);

  // ── New worker (w-b) re-claims ──
  for (const hid of handoff_ids) {
    await handoffsClaimRoute(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: 'w-b' }) }),
      hid, services,
    );
  }
  watchdog.recordHeartbeat('w-b');

  // ── Bounce 2: worker-b dies ──
  (watchdog as any).lastHeartbeats.set('w-b', Date.now() - 70_000);
  await watchdog.tick();

  for (const hid of handoff_ids) {
    const row = services.handoffReader.get(hid);
    expect(row?.status).toBe('approved');
    expect(row?.attempt_count).toBe(3);
  }

  // ── New worker (w-c) re-claims ──
  for (const hid of handoff_ids) {
    await handoffsClaimRoute(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: 'w-c' }) }),
      hid, services,
    );
  }
  watchdog.recordHeartbeat('w-c');

  // ── Bounce 3: attempt_count = max_attempts → must fail ──
  (watchdog as any).lastHeartbeats.set('w-c', Date.now() - 70_000);
  await watchdog.tick();

  // Criterion 6: cap enforced — no further retry
  for (const hid of handoff_ids) {
    const row = services.handoffReader.get(hid);
    expect(row?.status).toBe('failed');
    expect(row?.resolution_reason).toBe('worker_restart_attempts_exhausted');
  }

  // Criterion 5 (final): no dispatched rows remain
  const stuck2 = services.db
    .query<{ n: number }, []>(`SELECT count(*) AS n FROM handoffs WHERE status='dispatched'`)
    .get();
  expect(stuck2?.n).toBe(0);

  // Observability: watchdog.retry events emitted for bounces 1+2
  for (const hid of [h1.handoff_id, h2.handoff_id, h3.handoff_id]) {
    const events = services.dispatchEventLog.listByHandoff(hid);
    const retries = events.filter((e) => e.kind === 'watchdog.retry');
    expect(retries.length).toBe(2); // one per successful retry
  }
});

test('acceptance: persistently-failing mock (attempt_count pre-set to max) stops immediately', async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;

  const c = await createAndClaim(services, 'w-bad', 'conv-acc-4');
  // Simulate a dispatch that has already used all its attempts
  services.db.exec(`UPDATE handoffs SET attempt_count=3, max_attempts=3 WHERE handoff_id='${c.handoff_id}'`);

  watchdog.recordHeartbeat('w-bad');
  (watchdog as any).lastHeartbeats.set('w-bad', Date.now() - 70_000);
  await watchdog.tick();

  const row = services.handoffReader.get(c.handoff_id);
  expect(row?.status).toBe('failed');
  expect(row?.resolution_reason).toBe('worker_restart_attempts_exhausted');
  // Must not loop — status is terminal, a second tick leaves it unchanged
  await watchdog.tick();
  const row2 = services.handoffReader.get(c.handoff_id);
  expect(row2?.status).toBe('failed');
});
```

- [ ] **Step 2: Verify the tests fail**

```bash
bun test packages/daemon/test/services/watchdog-retry-acceptance.test.ts
```

Expected: failures because the implementation from Phase 3 hasn't been deployed yet
(or, if Phase 3 is already merged, tests pass — skip Step 3).

- [ ] **Step 3: No new implementation needed**

Phase 3 already implements the retry logic. If a gap is found, it belongs in
Phase 3's task (re-open 3.1, don't add new code here).

- [ ] **Step 4: Full suite verification**

```bash
bun test packages/daemon/test/services/watchdog-retry-acceptance.test.ts
bun test packages/daemon
bun test packages/core
cd /Volumes/WorkSSD/repos/personal/penumbra && bun run typecheck
```

Integration: Merge acceptance test alongside Phase 3 code in a single PR, or as a
follow-up commit on the same branch. The test is the living contract for GH #122.

---

## Open questions resolved

| # | Decision |
|---|----------|
| 1 | **Where does "orphaned" live?** Two columns on `handoffs` (`attempt_count`, `max_attempts`). No side-table needed; the existing `dispatch_events` table records each `watchdog.retry` event for telemetry. |
| 2 | **Retry policy.** Auto-retry by default (transparent to callers); surface as `failed` with `resolution_reason='worker_restart_attempts_exhausted'` when exhausted. Callers holding a `workflow_run_id` see the same run recover. |
| 3 | **Worker-liveness detection.** Existing `WatchdogService.lastHeartbeats` in-memory map — no new table. Workers already call `POST /worker/heartbeat` every ~15s; watchdog evicts stale entries at 60s. |
| 4 | **Dual-worker race.** `resetForRetry` uses a SQL CAS: `WHERE handoff_id=? AND status='dispatched' AND worker_id=?`. Returns `false` on miss — the second worker skips silently. |
| 5 | **Per-persona max-attempts default.** 3. Two transient bounces are recoverable; the third almost always indicates a persistent environment failure and should surface rather than loop. |
