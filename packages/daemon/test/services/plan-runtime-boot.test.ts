import {
  loadSqliteVec,
  migrate,
  PlanWriter,
  type TaskEvent,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { createPlanRuntimeSweeper } from "../../src/sweepers/plan-runtime.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // setCustomSQLite throws after SQLite has already loaded in the process.
}

function makeDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

test("plan-runtime sweeper start/stop is safe to call repeatedly", () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const bus = new TaskEventBus();
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name: string): { name: string; maestro_capable: boolean } => ({
      name,
      maestro_capable: true,
    }),
  });

  const sweeper = createPlanRuntimeSweeper({ db, plans, taskWriter, intervalMs: 100 });

  sweeper.start();
  sweeper.start();
  sweeper.stop();
  sweeper.stop();

  expect(true).toBe(true);
});

test("plan-runtime subscribe/unsubscribe is clean against a live bus", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const bus = new TaskEventBus();
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name: string): { name: string; maestro_capable: boolean } => ({
      name,
      maestro_capable: true,
    }),
  });

  const sweeper = createPlanRuntimeSweeper({ db, plans, taskWriter });

  const unsub = sweeper.subscribe(bus);
  unsub();

  const event: TaskEvent = {
    kind: "completed",
    task_id: "fake-task",
    at: Date.now(),
    actor: null,
    payload: null,
  };
  bus.publish(event);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });

  expect(true).toBe(true);
});
