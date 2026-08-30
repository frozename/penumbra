import {
  HandoffReader,
  HandoffWriter,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import {
  resolveStaleAfterMs,
  resolveSweeperSqlCutoffMs,
} from "@src/sweepers/stale-handoff-thresholds.js";
import { runStaleHandoffSweep, type StaleHandoffSweeperOpts } from "@src/sweepers/stale-handoff.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  noop();
}

type TransactionCallback = (...args: unknown[]) => unknown;

function noop(): void {
  return undefined;
}

function readJsonRecord(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function injectBeforeNextTransaction(db: Database, inject: () => void): void {
  const originalTransaction = db.transaction.bind(db);
  let injected = false;
  db.transaction = (<Callback extends TransactionCallback>(fn: Callback) =>
    originalTransaction((...args: Parameters<Callback>): ReturnType<Callback> => {
      if (!injected) {
        inject();
        injected = true;
      }
      return fn(...args) as ReturnType<Callback>;
    })) as typeof db.transaction;
}

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeServices(db: Database): Services {
  return {
    db,
    handoffWriter: new HandoffWriter({ db }),
    handoffReader: new HandoffReader({ db }),
    t0Writer: { write: noop },
    machineId: { get: () => "machine-test" },
    uuid: (() => {
      let n = 0;
      return () => `evt-${String(++n)}`;
    })(),
    clock: () => new Date(),
    log: { info: noop, warn: noop },
  } as unknown as Services;
}

function insertDispatchedHandoff(
  db: Database,
  handoff_id: string,
  ts: string,
  chainTaskType: string | null = null,
  workerId: string | null = null,
): void {
  db.run(
    `INSERT INTO handoffs (
       handoff_id, ts, project_id, conversation_id, from_agent, to_agent,
       to_role, message, status, use_worktree, worker_id, chain_task_type
     ) VALUES (?, ?, NULL, ?, 'maestro', 'worker', NULL, 'do work', 'dispatched', 1, ?, ?)`,
    [handoff_id, ts, `c-${handoff_id}`, workerId, chainTaskType],
  );
}

function insertEvent(db: Database, handoff_id: string, kind: string, ts: string): void {
  db.run(
    `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
     VALUES (?, NULL, 'worker', ?, ?, NULL)`,
    [handoff_id, kind, ts],
  );
}

function insertMemory(db: Database, memoryId: string): void {
  db.run(
    `INSERT INTO t2_memories(
      memory_id, project_id, user_id, kind, source_session_ids,
      window_start, window_end, title, body, metadata_json,
      compressed_from, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      memoryId,
      null,
      "u1",
      "fact",
      "[]",
      "2026-05-04T11:50:00.000Z",
      "2026-05-04T11:50:00.000Z",
      memoryId,
      "body",
      "{}",
      null,
      "2026-05-04T11:50:00.000Z",
      "2026-05-04T11:50:00.000Z",
    ],
  );
}

function makeOpts(services: Services): StaleHandoffSweeperOpts {
  return { services };
}

function makeTaskTypeAwareOpts(services: Services): StaleHandoffSweeperOpts {
  return {
    services,
    resolveStaleAfterMs,
  };
}

test("no handoffs → empty candidates and resolved", () => {
  const db = setupDb();
  const services = makeServices(db);
  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );
  expect(result.candidates).toEqual([]);
  expect(result.resolved).toEqual([]);
});

test("fresh dispatched handoff → not a candidate", () => {
  const db = setupDb();
  const services = makeServices(db);
  // Dispatched 30 seconds ago; smoke-test threshold is 5 min and default is 15 min.
  insertDispatchedHandoff(db, "h-fresh", "2026-05-04T11:59:30.000Z");
  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );
  expect(result.candidates).toEqual([]);
  expect(result.resolved).toEqual([]);
});

test("stale dispatched handoff with no dispatch.end → force-resolved", () => {
  const db = setupDb();
  const services = makeServices(db);
  // Dispatched 10 minutes ago, no dispatch.end.
  insertDispatchedHandoff(db, "h-wedged", "2026-05-04T11:50:00.000Z");
  insertEvent(db, "h-wedged", "dispatch.start", "2026-05-04T11:50:01.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.candidates).toEqual(["h-wedged"]);
  expect(result.resolved).toEqual(["h-wedged"]);

  const endRow = db
    .query<
      { kind: string; source: string; meta_json: string | null },
      [string]
    >(`SELECT kind, source, meta_json FROM dispatch_events WHERE handoff_id = ? AND kind = 'dispatch.end'`)
    .get("h-wedged");
  expect(endRow).not.toBeNull();
  expect(endRow!.source).toBe("sweeper");
  expect(readJsonRecord(endRow!.meta_json ?? "{}").reason).toBe("stale_force_resolve");

  const handoff = services.handoffReader.get("h-wedged");
  expect(handoff?.status).toBe("failed");
  expect(handoff?.resolution_reason).toBe("stale_force_resolve");
  expect(handoff?.resolved_by).toBe("stale-handoff-sweeper");
});

test("markFailed crash rolls back synthetic dispatch.end but does not throw", () => {
  const db = setupDb();
  const services = makeServices(db);
  const originalMarkFailed = services.handoffWriter.markFailed.bind(services.handoffWriter);
  services.handoffWriter.markFailed = mock(() => {
    throw new Error("markFailed crashed");
  });

  insertDispatchedHandoff(db, "h-rollback", "2026-05-04T11:50:00.000Z");
  insertEvent(db, "h-rollback", "dispatch.start", "2026-05-04T11:50:01.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );
  expect(result.resolved).toEqual([]);

  const endCount = db
    .query<
      { count: number },
      [string]
    >(`SELECT COUNT(*) as count FROM dispatch_events WHERE handoff_id = ? AND kind = 'dispatch.end'`)
    .get("h-rollback");
  expect(endCount?.count).toBe(0);
  expect(services.handoffReader.get("h-rollback")?.status).toBe("dispatched");

  services.handoffWriter.markFailed = originalMarkFailed;
  const retry = runStaleHandoffSweep(
    makeOpts(services),
    { lastSwept: new Map<string, number>() },
    () => new Date("2026-05-04T12:01:01.000Z"),
  );
  expect(retry.resolved).toEqual(["h-rollback"]);
});

test("candidate flipping to terminal mid-loop skips gracefully without throwing", () => {
  const db = setupDb();
  const services = makeServices(db);
  const originalMarkFailed = services.handoffWriter.markFailed.bind(services.handoffWriter);

  insertDispatchedHandoff(db, "h-flip", "2026-05-04T11:50:00.000Z");
  insertDispatchedHandoff(db, "h-next", "2026-05-04T11:50:00.000Z");
  insertEvent(db, "h-flip", "dispatch.start", "2026-05-04T11:50:01.000Z");
  insertEvent(db, "h-next", "dispatch.start", "2026-05-04T11:50:01.000Z");

  services.handoffWriter.markFailed = mock<typeof services.handoffWriter.markFailed>(
    (handoffId, opts) => {
      if (handoffId === "h-flip") {
        db.run("UPDATE handoffs SET status = 'completed' WHERE handoff_id = ?", [handoffId]);
      }
      return originalMarkFailed(handoffId, opts);
    },
  );

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.candidates.sort()).toEqual(["h-flip", "h-next"].sort());
  expect(result.resolved).toEqual(["h-next"]);

  const endCount = db
    .query<
      { count: number },
      [string]
    >(`SELECT COUNT(*) as count FROM dispatch_events WHERE handoff_id = ? AND kind = 'dispatch.end'`)
    .get("h-flip");
  expect(endCount?.count).toBe(0);

  const hNext = services.handoffReader.get("h-next");
  expect(hNext?.status).toBe("failed");
  expect(hNext?.resolution_reason).toBe("stale_force_resolve");
});

test("markFailed genuine exception skips candidate but continues to others", () => {
  const db = setupDb();
  const services = makeServices(db);
  const originalMarkFailed = services.handoffWriter.markFailed.bind(services.handoffWriter);

  insertDispatchedHandoff(db, "h-crash", "2026-05-04T11:50:00.000Z");
  insertDispatchedHandoff(db, "h-ok", "2026-05-04T11:50:00.000Z");
  insertEvent(db, "h-crash", "dispatch.start", "2026-05-04T11:50:01.000Z");
  insertEvent(db, "h-ok", "dispatch.start", "2026-05-04T11:50:01.000Z");

  services.handoffWriter.markFailed = mock<typeof services.handoffWriter.markFailed>(
    (handoffId, opts) => {
      if (handoffId === "h-crash") {
        throw new Error("markFailed crashed");
      }
      return originalMarkFailed(handoffId, opts);
    },
  );

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.candidates.sort()).toEqual(["h-crash", "h-ok"].sort());
  expect(result.resolved).toEqual(["h-ok"]);

  const endCount = db
    .query<
      { count: number },
      [string]
    >(`SELECT COUNT(*) as count FROM dispatch_events WHERE handoff_id = ? AND kind = 'dispatch.end'`)
    .get("h-crash");
  expect(endCount?.count).toBe(0);
});

test("multiple stale candidates are classified consistently with batched dispatch event lookup", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-batch-sweep", "2026-05-04T11:48:00.000Z", "smoke_test");
  insertDispatchedHandoff(db, "h-batch-end", "2026-05-04T11:49:00.000Z", "smoke_test");
  insertDispatchedHandoff(db, "h-batch-fresh", "2026-05-04T11:51:00.000Z", "smoke_test");

  insertEvent(db, "h-batch-sweep", "dispatch.start", "2026-05-04T11:48:01.000Z");
  insertEvent(db, "h-batch-end", "dispatch.start", "2026-05-04T11:49:01.000Z");
  insertEvent(db, "h-batch-end", "dispatch.end", "2026-05-04T11:49:31.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.candidates.sort()).toEqual(["h-batch-end", "h-batch-sweep"].sort());
  expect(result.resolved).toEqual(["h-batch-sweep"]);

  const hBatchSweep = services.handoffReader.get("h-batch-sweep");
  const hBatchEnd = services.handoffReader.get("h-batch-end");
  const hBatchFresh = services.handoffReader.get("h-batch-fresh");
  expect(hBatchSweep?.status).toBe("failed");
  expect(hBatchEnd?.status).toBe("dispatched");
  expect(hBatchFresh?.status).toBe("dispatched");
});

test("review_adversarial handoff at 44m59s old is not swept", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-review", "2026-05-04T11:15:01.000Z", "review_adversarial");
  insertEvent(db, "h-review", "dispatch.start", "2026-05-04T11:25:01.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.candidates).toEqual([]);
  expect(result.resolved).toEqual([]);
  expect(services.handoffReader.get("h-review")?.status).toBe("dispatched");
});

test("plan_refine handoff at 44m59s old is not swept", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-plan", "2026-05-04T11:15:01.000Z", "plan_refine");
  insertEvent(db, "h-plan", "dispatch.start", "2026-05-04T11:25:01.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.candidates).toEqual([]);
  expect(result.resolved).toEqual([]);
  expect(services.handoffReader.get("h-plan")?.status).toBe("dispatched");
});

test("smoke_test handoff at 10m01s old is swept", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-smoke", "2026-05-04T11:49:59.000Z", "smoke_test");
  insertEvent(db, "h-smoke", "dispatch.start", "2026-05-04T11:50:01.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.candidates).toEqual(["h-smoke"]);
  expect(result.resolved).toEqual(["h-smoke"]);
});

test("implement_small handoff at 60m01s old is swept", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-small", "2026-05-04T10:59:59.000Z", "implement_small");
  insertEvent(db, "h-small", "dispatch.start", "2026-05-04T11:00:01.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.candidates).toEqual(["h-small"]);
  expect(result.resolved).toEqual(["h-small"]);
});

test("smoke_test handoff at 9m59s old is not swept", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-smoke-fresh", "2026-05-04T11:50:01.000Z", "smoke_test");
  insertEvent(db, "h-smoke-fresh", "dispatch.start", "2026-05-04T11:50:02.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.candidates).toEqual([]);
  expect(result.resolved).toEqual([]);
});

test("review_adversarial handoff at 45m01s old is swept", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-review-old", "2026-05-04T11:14:59.000Z", "review_adversarial");
  insertEvent(db, "h-review-old", "dispatch.start", "2026-05-04T11:15:00.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.candidates).toEqual(["h-review-old"]);
  expect(result.resolved).toEqual(["h-review-old"]);
});

test("implement_small handoff at 59m59s old is not swept", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-small-fresh", "2026-05-04T11:00:01.000Z", "implement_small");
  insertEvent(db, "h-small-fresh", "dispatch.start", "2026-05-04T11:00:02.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.candidates).toEqual([]);
  expect(result.resolved).toEqual([]);
});

test("task-type thresholds include Phase 1 uplift while keeping health and smoke unchanged", () => {
  expect(resolveStaleAfterMs(undefined)).toBe(30 * 60_000);
  expect(resolveStaleAfterMs(null)).toBe(30 * 60_000);
  expect(resolveStaleAfterMs("implement_small")).toBe(60 * 60_000);
  expect(resolveStaleAfterMs("implement_substantial")).toBe(90 * 60_000);
  expect(resolveStaleAfterMs("plan_refine")).toBe(45 * 60_000);
  expect(resolveStaleAfterMs("health_check")).toBe(5 * 60_000);
  expect(resolveStaleAfterMs("smoke_test")).toBe(10 * 60_000);
});

test("resolveSweeperSqlCutoffMs uses the smallest configured threshold for function resolvers", () => {
  expect(resolveSweeperSqlCutoffMs(resolveStaleAfterMs)).toBe(5 * 60_000);
  expect(resolveSweeperSqlCutoffMs(15 * 60_000)).toBe(15 * 60_000);
});

test("constant resolveStaleAfterMs still behaves like a fixed threshold", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-constant", "2026-05-04T11:44:00.000Z", "review_adversarial");
  insertEvent(db, "h-constant", "dispatch.start", "2026-05-04T11:44:01.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    { services, resolveStaleAfterMs: 15 * 60_000 },
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.candidates).toEqual(["h-constant"]);
  expect(result.resolved).toEqual(["h-constant"]);
});

test("deprecated staleAfterMs alias still works and warns once", () => {
  const db = setupDb();
  const services = makeServices(db);
  const warn = mock(noop);
  insertDispatchedHandoff(db, "h-alias", "2026-05-04T11:44:00.000Z", "review_adversarial");
  insertEvent(db, "h-alias", "dispatch.start", "2026-05-04T11:44:01.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    { services, staleAfterMs: 15 * 60_000, log: { warn } },
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.candidates).toEqual(["h-alias"]);
  expect(result.resolved).toEqual(["h-alias"]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    { option: "staleAfterMs" },
    "staleAfterMs is deprecated; use resolveStaleAfterMs instead",
  );
});

test("stale dispatched but dispatch.end already present → not resolved", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-end-present", "2026-05-04T11:50:00.000Z");
  insertEvent(db, "h-end-present", "dispatch.start", "2026-05-04T11:50:01.000Z");
  insertEvent(db, "h-end-present", "dispatch.end", "2026-05-04T11:55:00.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.candidates).toEqual(["h-end-present"]);
  expect(result.resolved).toEqual([]);

  const handoff = services.handoffReader.get("h-end-present");
  expect(handoff?.status).toBe("dispatched");
});

test("stale handoff with recent agent activity is NOT force-resolved", () => {
  const db = setupDb();
  const services = makeServices(db);
  // Dispatched 6 minutes ago (past 5min default threshold), but emitting events recently.
  insertDispatchedHandoff(db, "h-active", "2026-05-04T11:54:00.000Z");
  insertEvent(db, "h-active", "dispatch.start", "2026-05-04T11:54:01.000Z");
  insertEvent(db, "h-active", "agent.thought", "2026-05-04T11:59:30.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    { services, activityIdleMs: 90_000 },
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.resolved).toEqual([]);

  const handoff = services.handoffReader.get("h-active");
  expect(handoff?.status).toBe("dispatched");
});

test("cooldown holds → second sweep does not re-process the same handoff", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-cool", "2026-05-04T11:50:00.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const first = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );
  expect(first.resolved).toEqual(["h-cool"]);

  // Second tick within the cooldown window: same handoff already failed,
  // and even if it were still dispatched, the cooldown would skip it.
  // Re-insert as dispatched to prove the cooldown branch fires (independent of status).
  db.run(
    `UPDATE handoffs SET status='dispatched', resolved_at=NULL, resolved_by=NULL, resolution_reason=NULL WHERE handoff_id='h-cool'`,
  );

  const second = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date("2026-05-04T12:00:30.000Z"),
  );
  expect(second.candidates).toEqual([]);
  expect(second.resolved).toEqual([]);
});

test("liveness gate OFF keeps current behavior (fresh heartbeat still resolves)", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-live-off", "2026-05-04T11:40:00.000Z", null, "worker-live");
  insertEvent(db, "h-live-off", "dispatch.start", "2026-05-04T11:40:01.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    {
      services,
      resolveStaleAfterMs: 5 * 60_000,
      livenessCheckEnabled: false,
      isWorkerHeartbeatFresh: () => true,
    },
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.resolved).toEqual(["h-live-off"]);
  expect(services.handoffReader.get("h-live-off")?.status).toBe("failed");
});

test("liveness gate ON defers fresh worker under grace", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-live-grace", "2026-05-04T11:40:00.000Z", null, "worker-live");
  insertEvent(db, "h-live-grace", "dispatch.start", "2026-05-04T11:40:01.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    {
      services,
      resolveStaleAfterMs: 5 * 60_000,
      livenessCheckEnabled: true,
      maxAliveGraceMs: 30 * 60_000,
      isWorkerHeartbeatFresh: () => true,
    },
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.resolved).toEqual([]);
  expect(services.handoffReader.get("h-live-grace")?.status).toBe("dispatched");
});

test("liveness gate ON still resolves fresh worker once grace is exceeded", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-live-over-grace", "2026-05-04T11:20:00.000Z", null, "worker-live");
  insertEvent(db, "h-live-over-grace", "dispatch.start", "2026-05-04T11:20:01.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    {
      services,
      resolveStaleAfterMs: 5 * 60_000,
      livenessCheckEnabled: true,
      maxAliveGraceMs: 30 * 60_000,
      isWorkerHeartbeatFresh: () => true,
    },
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.resolved).toEqual(["h-live-over-grace"]);
  expect(services.handoffReader.get("h-live-over-grace")?.status).toBe("failed");
});

test("liveness gate ON fail-closed resolves stale or unknown workers", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-live-stale", "2026-05-04T11:40:00.000Z", null, "worker-stale");
  insertDispatchedHandoff(db, "h-live-unknown", "2026-05-04T11:40:00.000Z", null, null);
  insertEvent(db, "h-live-stale", "dispatch.start", "2026-05-04T11:40:01.000Z");
  insertEvent(db, "h-live-unknown", "dispatch.start", "2026-05-04T11:40:01.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    {
      services,
      resolveStaleAfterMs: 5 * 60_000,
      livenessCheckEnabled: true,
      maxAliveGraceMs: 30 * 60_000,
      isWorkerHeartbeatFresh: (workerId: string) => workerId !== "worker-stale",
    },
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.resolved.sort()).toEqual(["h-live-stale", "h-live-unknown"]);
  expect(services.handoffReader.get("h-live-stale")?.status).toBe("failed");
  expect(services.handoffReader.get("h-live-unknown")?.status).toBe("failed");
});

test("liveness probe errors fail closed and do not block stale resolution", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-live-throw", "2026-05-04T11:40:00.000Z", null, "worker-throw");
  insertEvent(db, "h-live-throw", "dispatch.start", "2026-05-04T11:40:01.000Z");

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    {
      services,
      resolveStaleAfterMs: 5 * 60_000,
      livenessCheckEnabled: true,
      maxAliveGraceMs: 30 * 60_000,
      isWorkerHeartbeatFresh: () => {
        throw new Error("probe failed");
      },
    },
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.resolved).toEqual(["h-live-throw"]);
  expect(services.handoffReader.get("h-live-throw")?.status).toBe("failed");
});

test("TOCTOU race closed: dispatch.end injected before markFailed prevents stale resolution", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-race-end", "2026-05-04T11:50:00.000Z");
  insertEvent(db, "h-race-end", "dispatch.start", "2026-05-04T11:50:01.000Z");

  injectBeforeNextTransaction(services.db, () => {
    insertEvent(db, "h-race-end", "dispatch.end", "2026-05-04T11:59:59.000Z");
  });

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.resolved).toEqual([]);
  const handoff = services.handoffReader.get("h-race-end");
  expect(handoff?.status).toBe("dispatched");
});

test("TOCTOU race closed: recent heartbeat injected before markFailed prevents stale resolution", () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, "h-race-heartbeat", "2026-05-04T11:50:00.000Z");
  insertEvent(db, "h-race-heartbeat", "dispatch.start", "2026-05-04T11:50:01.000Z");

  injectBeforeNextTransaction(services.db, () => {
    insertEvent(db, "h-race-heartbeat", "agent.heartbeat", "2026-05-04T11:58:00.000Z");
  });

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  expect(result.resolved).toEqual([]);
  const handoff = services.handoffReader.get("h-race-heartbeat");
  expect(handoff?.status).toBe("dispatched");
});

test("REGRESSION: barely-stale SHORT-TTL handoff is still swept", () => {
  const db = setupDb();
  const services = makeServices(db);
  // smoke_test TTL is 10m.
  // Handoff created at 11:49:50.
  insertDispatchedHandoff(db, "h-regress-short", "2026-05-04T11:49:50.000Z", "smoke_test");
  // dispatch.start slightly after creation
  insertEvent(db, "h-regress-short", "dispatch.start", "2026-05-04T11:49:53.000Z");

  const state = { lastSwept: new Map<string, number>() };
  // At 12:00:00, handoff age is 10m10s (past 10m TTL).
  // Age of last event is 10m07s, which is > activityIdleMs (5m).
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date("2026-05-04T12:00:00.000Z"),
  );

  // Must still be swept.
  expect(result.resolved).toEqual(["h-regress-short"]);
  const handoff = services.handoffReader.get("h-regress-short");
  expect(handoff?.status).toBe("failed");
});
