import {
  HandoffReader,
  HandoffWriter,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";

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

type LogEntry = { level: "info" | "warn" | "error"; obj: unknown; msg: string };

const logs: LogEntry[] = [];

function makeServices(db: Database, now: Date): Services {
  return {
    db,
    handoffWriter: new HandoffWriter({ db }),
    handoffReader: new HandoffReader({ db }),
    clock: (): Date => now,
    log: {
      info: (obj: unknown, msg: string): void => {
        logs.push({ level: "info", obj, msg });
      },
      warn: (obj: unknown, msg: string): void => {
        logs.push({ level: "warn", obj, msg });
      },
      error: (obj: unknown, msg: string): void => {
        logs.push({ level: "error", obj, msg });
      },
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

function readRow(
  db: Database,
  handoff_id: string,
): { status: string; resolution_reason: string | null } {
  const row = db
    .query<
      { status: string; resolution_reason: string | null },
      [string]
    >(`SELECT status, resolution_reason FROM handoffs WHERE handoff_id=?`)
    .get(handoff_id);
  if (!row) throw new Error(`missing handoff ${handoff_id}`);
  return row;
}

// Fixed reference point for all tests.
const NOW = new Date("2026-01-01T12:00:00.000Z");
const m = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString();

let savedPendingTtlEnv: string | undefined;
let savedDispatchedTtlEnv: string | undefined;

beforeEach(() => {
  savedPendingTtlEnv = process.env.PENUMBRA_HANDOFF_PENDING_TTL_MS;
  savedDispatchedTtlEnv = process.env.PENUMBRA_HANDOFF_DISPATCHED_TTL_MS;
  delete process.env.PENUMBRA_HANDOFF_PENDING_TTL_MS;
  delete process.env.PENUMBRA_HANDOFF_DISPATCHED_TTL_MS;
  logs.length = 0;
});

afterEach(() => {
  if (savedPendingTtlEnv === undefined) delete process.env.PENUMBRA_HANDOFF_PENDING_TTL_MS;
  else process.env.PENUMBRA_HANDOFF_PENDING_TTL_MS = savedPendingTtlEnv;
  if (savedDispatchedTtlEnv === undefined) delete process.env.PENUMBRA_HANDOFF_DISPATCHED_TTL_MS;
  else process.env.PENUMBRA_HANDOFF_DISPATCHED_TTL_MS = savedDispatchedTtlEnv;
});

test("SQL candidate cutoff uses the smallest class TTL: health_check at 6min expires", async () => {
  const db = setupDb();
  const services = makeServices(db, NOW);
  insertDispatchedHandoff(db, "h-health", m(6), "health_check");

  const worker = createHandoffSweeperWorker({ services });
  await worker.tick();

  expect(readRow(db, "h-health").status).toBe("expired");
});

test("pending env override expires with the exact env-derived reason", async () => {
  process.env.PENUMBRA_HANDOFF_PENDING_TTL_MS = "600000";
  const db = setupDb();
  const services = makeServices(db, NOW);
  insertPendingHandoff(db, "h-pending-env", m(11));

  const worker = createHandoffSweeperWorker({ services });
  await worker.tick();

  const row = readRow(db, "h-pending-env");
  expect(row.status).toBe("expired");
  expect(row.resolution_reason).toBe("expired by sweeper after 600000ms in pending");
});

test("opts.pendingTtlMs beats the pending env override", async () => {
  process.env.PENUMBRA_HANDOFF_PENDING_TTL_MS = "60000";
  const db = setupDb();
  const services = makeServices(db, NOW);
  insertPendingHandoff(db, "h-pending-opts", m(61));

  const worker = createHandoffSweeperWorker({ services, pendingTtlMs: 7_200_000 });
  await worker.tick();

  expect(readRow(db, "h-pending-opts").status).toBe("pending");
});

test("non-numeric pending env falls back to the default without logging an error", async () => {
  process.env.PENUMBRA_HANDOFF_PENDING_TTL_MS = "abc";
  const db = setupDb();
  const services = makeServices(db, NOW);
  insertPendingHandoff(db, "h-pending-abc", m(61));

  const worker = createHandoffSweeperWorker({ services });
  await worker.tick();

  const row = readRow(db, "h-pending-abc");
  expect(row.status).toBe("expired");
  expect(row.resolution_reason).toContain("3600000ms in pending");
  expect(logs.some((entry) => entry.level === "error")).toBe(false);
});

test("empty pending env falls back to the default around the 60-minute boundary", async () => {
  process.env.PENUMBRA_HANDOFF_PENDING_TTL_MS = "";
  const db = setupDb();
  const services = makeServices(db, NOW);
  insertPendingHandoff(db, "h-pending-59", m(59));
  insertPendingHandoff(db, "h-pending-61", m(61));

  const worker = createHandoffSweeperWorker({ services });
  await worker.tick();

  expect(readRow(db, "h-pending-59").status).toBe("pending");
  expect(readRow(db, "h-pending-61").status).toBe("expired");
});

test("dispatched env override is flat across classes with the exact reason", async () => {
  process.env.PENUMBRA_HANDOFF_DISPATCHED_TTL_MS = "600000";
  const db = setupDb();
  const services = makeServices(db, NOW);
  insertDispatchedHandoff(db, "h-dispatch-env", m(11), "debug_diagnose");

  const worker = createHandoffSweeperWorker({ services });
  await worker.tick();

  const row = readRow(db, "h-dispatch-env");
  expect(row.status).toBe("expired");
  expect(row.resolution_reason).toBe(
    "expired by sweeper after 600000ms in dispatched (task_type=debug_diagnose)",
  );
});

test("opts.dispatchedTtlMs beats the dispatched env override", async () => {
  process.env.PENUMBRA_HANDOFF_DISPATCHED_TTL_MS = "60000";
  const db = setupDb();
  const services = makeServices(db, NOW);
  insertDispatchedHandoff(db, "h-dispatch-opts", m(35), "implement_small");

  const worker = createHandoffSweeperWorker({ services, dispatchedTtlMs: 3_600_000 });
  await worker.tick();

  expect(readRow(db, "h-dispatch-opts").status).toBe("dispatched");
});

test("null task_type expires with the exact default reason and no suffix", async () => {
  const db = setupDb();
  const services = makeServices(db, NOW);
  insertDispatchedHandoff(db, "h-null-type", m(31));

  const worker = createHandoffSweeperWorker({ services });
  await worker.tick();

  const row = readRow(db, "h-null-type");
  expect(row.status).toBe("expired");
  expect(row.resolution_reason).toBe("expired by sweeper after 1800000ms in dispatched");
});

test("unknown task_type uses the 30-minute default but keeps the suffix", async () => {
  const db = setupDb();
  const services = makeServices(db, NOW);
  insertDispatchedHandoff(db, "h-mystery-29", m(29), "mystery");
  insertDispatchedHandoff(db, "h-mystery-31", m(31), "mystery");

  const worker = createHandoffSweeperWorker({ services });
  await worker.tick();

  expect(readRow(db, "h-mystery-29").status).toBe("dispatched");
  const expired = readRow(db, "h-mystery-31");
  expect(expired.status).toBe("expired");
  expect(expired.resolution_reason).toBe(
    "expired by sweeper after 1800000ms in dispatched (task_type=mystery)",
  );
});

test("info log fires once with the summed expired count", async () => {
  const db = setupDb();
  const services = makeServices(db, NOW);
  insertPendingHandoff(db, "h-log-pending", m(61));
  insertDispatchedHandoff(db, "h-log-dispatched", m(31));

  const worker = createHandoffSweeperWorker({ services });
  await worker.tick();

  const infos = logs.filter((entry) => entry.level === "info");
  expect(infos.length).toBe(1);
  expect(infos[0]?.obj).toEqual({ count: 2 });
  expect(infos[0]?.msg).toBe("handoff sweeper: marked stuck handoffs as expired");
});

test("no info log when nothing expired", async () => {
  const db = setupDb();
  const services = makeServices(db, NOW);
  insertPendingHandoff(db, "h-fresh-pending", m(1));
  insertDispatchedHandoff(db, "h-fresh-dispatched", m(1));

  const worker = createHandoffSweeperWorker({ services });
  await worker.tick();

  expect(logs.some((entry) => entry.level === "info")).toBe(false);
});

test("a sweep failure is contained and logged once", async () => {
  const db = setupDb();
  const services = makeServices(db, NOW);
  services.handoffWriter.expirePendingOlderThan = (): number => {
    throw new Error("boom");
  };

  const worker = createHandoffSweeperWorker({ services });
  let outcome = "resolved";
  try {
    await worker.tick();
  } catch {
    outcome = "rejected";
  }

  expect(outcome).toBe("resolved");
  const errors = logs.filter((entry) => entry.level === "error");
  expect(errors.length).toBe(1);
  expect(errors[0]?.msg).toBe("handoff sweeper: failed to sweep handoffs");
  const err = (errors[0]?.obj as { err?: unknown }).err;
  expect((err as Error).message).toBe("boom");
});
