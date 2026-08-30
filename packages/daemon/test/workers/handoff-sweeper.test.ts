import {
  HandoffReader,
  HandoffWriter,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import { resolveDispatchedTtlMs } from "@src/workers/handoff-sweeper-thresholds.js";
import { createHandoffSweeperWorker } from "@src/workers/handoff-sweeper.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // ignore: platform-specific sqlite setup
}

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeServices(db: Database, now: Date): Services {
  return {
    db,
    handoffWriter: new HandoffWriter({ db }),
    handoffReader: new HandoffReader({ db }),
    t0Writer: { write: (): void => undefined },
    machineId: { get: (): string => "machine-test" },
    uuid: (() => {
      let n = 0;
      return (): string => `evt-${String(++n)}`;
    })(),
    clock: (): Date => now,
    log: {
      info: (): void => undefined,
      warn: (): void => undefined,
      error: (): void => undefined,
    },
  } as unknown as Services;
}

function insertDispatchedHandoff(
  db: Database,
  handoff_id: string,
  ts: string,
  chain_task_type: string | null = null,
): void {
  db.run(
    `INSERT INTO handoffs (
       handoff_id, ts, project_id, conversation_id, from_agent, to_agent,
       to_role, message, status, use_worktree, chain_task_type
     ) VALUES (?, ?, NULL, ?, 'maestro', 'worker', NULL, 'do work', 'dispatched', 1, ?)`,
    [handoff_id, ts, `c-${handoff_id}`, chain_task_type],
  );
}

function insertPendingHandoff(db: Database, handoff_id: string, ts: string): void {
  db.run(
    `INSERT INTO handoffs (
       handoff_id, ts, project_id, conversation_id, from_agent, to_agent,
       to_role, message, status, use_worktree, chain_task_type
     ) VALUES (?, ?, NULL, ?, 'maestro', 'worker', NULL, 'do work', 'pending', 1, NULL)`,
    [handoff_id, ts, `c-${handoff_id}`],
  );
}

function insertDispatchEvent(db: Database, handoff_id: string, kind: string, ts: string): void {
  db.run(
    `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
     VALUES (?, NULL, 'worker', ?, ?, NULL)`,
    [handoff_id, kind, ts],
  );
}

// Fixed reference point for all tests.
const NOW = new Date("2026-01-01T12:00:00.000Z");
const m = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString();
const s = (sec: number): string => new Date(NOW.getTime() - sec * 1_000).toISOString();

test("continuous-activity survives: dispatched 35min ago with recent events is not expired", async () => {
  const db = setupDb();
  const services = makeServices(db, NOW);
  insertDispatchedHandoff(db, "h-live", m(35));
  insertDispatchEvent(db, "h-live", "dispatch.start", m(35));
  insertDispatchEvent(db, "h-live", "agent.thought", m(5));
  insertDispatchEvent(db, "h-live", "agent.thought", s(30));

  const worker = createHandoffSweeperWorker({ services });
  await worker.tick();

  const handoff = services.handoffReader.get("h-live");
  expect(handoff?.status).toBe("dispatched");
});

test("wedged handoff expires: dispatched 35min ago with no events becomes expired", async () => {
  const db = setupDb();
  const services = makeServices(db, NOW);
  insertDispatchedHandoff(db, "h-wedged", m(35));

  const worker = createHandoffSweeperWorker({ services });
  await worker.tick();

  const handoff = services.handoffReader.get("h-wedged");
  expect(handoff?.status).toBe("expired");
  expect(handoff?.resolution_reason).toContain("expired by sweeper after");
});

test("per-task TTL: debug_diagnose (45min) survives at 35min; smoke_test (10min) expires at 35min", async () => {
  const db = setupDb();
  const services = makeServices(db, NOW);
  // debug_diagnose threshold is 45min — 35min old should survive.
  insertDispatchedHandoff(db, "h-debug", m(35), "debug_diagnose");
  // smoke_test threshold is 10min — 35min old should expire.
  insertDispatchedHandoff(db, "h-smoke", m(35), "smoke_test");

  const worker = createHandoffSweeperWorker({ services });
  await worker.tick();

  const debug = services.handoffReader.get("h-debug");
  const smoke = services.handoffReader.get("h-smoke");
  expect(debug?.status).toBe("dispatched");
  expect(smoke?.status).toBe("expired");
  expect(smoke?.resolution_reason).toContain("task_type=smoke_test");
});

test("flat TTL override wins over per-task-class: debug_diagnose at 35min expires when override=10min", async () => {
  const db = setupDb();
  const services = makeServices(db, NOW);
  // debug_diagnose would normally survive to 45min, but flat override is 10min.
  insertDispatchedHandoff(db, "h-override", m(35), "debug_diagnose");

  const worker = createHandoffSweeperWorker({ services, dispatchedTtlMs: 10 * 60_000 });
  await worker.tick();

  const handoff = services.handoffReader.get("h-override");
  expect(handoff?.status).toBe("expired");
  expect(handoff?.resolution_reason).toContain("expired by sweeper after");
});

test("pending handoffs still expire after pending TTL (60min)", async () => {
  const db = setupDb();
  const services = makeServices(db, NOW);
  insertPendingHandoff(db, "h-pending", m(61));

  const worker = createHandoffSweeperWorker({ services });
  await worker.tick();

  const handoff = services.handoffReader.get("h-pending");
  expect(handoff?.status).toBe("expired");
  expect(handoff?.resolution_reason).toContain("expired by sweeper after");
  expect(handoff?.resolution_reason).toContain("in pending");
});

test("resolveDispatchedTtlMs returns 45min for plan_refine", () => {
  expect(resolveDispatchedTtlMs("plan_refine")).toBe(45 * 60_000);
});

test("TOCTOU race closed: event injected between candidate scan and update prevents expiration", async () => {
  const db = setupDb();
  const services = makeServices(db, NOW);
  insertDispatchedHandoff(db, "h-race", m(35));

  const originalTransaction = services.db.transaction.bind(services.db);
  let injected = false;
  type DbTxFn = typeof services.db.transaction;
  const mockFn = (fn: (...args: unknown[]) => unknown): ((...args: unknown[]) => unknown) => {
    return originalTransaction((...args: unknown[]) => {
      if (!injected) {
        // Inject a recent event just as the transaction starts, simulating a race where
        // a worker heartbeat arrived after the candidate scan but before the UPDATE.
        insertDispatchEvent(db, "h-race", "agent.heartbeat", s(10));
        injected = true;
      }
      return fn(...args);
    });
  };
  services.db.transaction = mock(mockFn) as unknown as DbTxFn;

  const worker = createHandoffSweeperWorker({ services });
  await worker.tick();

  const handoff = services.handoffReader.get("h-race");
  expect(handoff?.status).toBe("dispatched");
});
