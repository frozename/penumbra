import {
  loadSqliteVec,
  MaestroSessionWriter,
  migrate,
  type TaskEvent,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runOrchestrateDeferralSweep } from "../../src/sweepers/orchestrate-deferral.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // Optional Homebrew SQLite is unavailable on non-local runners.
}

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function insertDeferredEvent(db: Database, taskId: string, at: number, resumeAtMs: number): void {
  db.query<unknown, [string, number, string]>(
    `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
     VALUES (?, ?, 'orchestrate_deferred', NULL, ?)`,
  ).run(
    taskId,
    at,
    JSON.stringify({ reason: "subscription_pressure_capped", resume_at_ms: resumeAtMs }),
  );
}

function insertTask(db: Database, bus: TaskEventBus): string {
  const writer = new TaskWriter(db, {
    now: (): number => 100,
    bus,
    resolveAgent: (
      name,
    ): { maestro_capable: boolean; name: string; tags: never[]; tier: "premium" } | undefined =>
      name === "claude"
        ? {
            name: "claude",
            maestro_capable: true,
            tags: [],
            tier: "premium",
          }
        : undefined,
  });
  const filed = writer.file({
    prompt: "orchestrate",
    kind: "orchestrate",
    eligibility: { allow_agents: ["claude"] },
    created_by_kind: "human",
    created_by_id: "test",
  });
  return filed.task_id;
}

test("due deferred event publishes filed and writes orchestrate_resumed", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const taskId = insertTask(db, bus);
  insertDeferredEvent(db, taskId, 1_000, 4_000);

  const events = bus.subscribe((event) => event.kind === "filed");
  const result = runOrchestrateDeferralSweep({ db, bus, now: () => 5_000 });

  expect(result.resumed).toEqual([taskId]);
  const timeoutResult: IteratorResult<TaskEvent> = { done: true, value: undefined as never };
  const published = await Promise.race<IteratorResult<TaskEvent>>([
    events.next(),
    Bun.sleep(50).then(() => timeoutResult),
  ]);
  expect(published.done).toBe(false);
  if (published.done) {
    throw new Error("expected filed event before timeout");
  }
  expect(published.value.task_id).toBe(taskId);

  const resumedCount = db
    .query<
      { n: number },
      [string]
    >(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'orchestrate_resumed'`)
    .get(taskId);
  expect(resumedCount?.n).toBe(1);

  await events.return?.();
  db.close();
});

test("future resume_at_ms does nothing", () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const taskId = insertTask(db, bus);
  insertDeferredEvent(db, taskId, 1_000, 9_000);

  const result = runOrchestrateDeferralSweep({ db, bus, now: () => 5_000 });
  expect(result.resumed).toEqual([]);

  const resumedCount = db
    .query<
      { n: number },
      [string]
    >(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'orchestrate_resumed'`)
    .get(taskId);
  expect(resumedCount?.n).toBe(0);

  db.close();
});

test("subsequent orchestrate_spawned blocks resuming", () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const taskId = insertTask(db, bus);
  insertDeferredEvent(db, taskId, 1_000, 4_000);
  db.query<unknown, [string, number, string]>(
    `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
     VALUES (?, ?, 'orchestrate_spawned', NULL, ?)`,
  ).run(taskId, 2_000, JSON.stringify({}));

  const result = runOrchestrateDeferralSweep({ db, bus, now: () => 5_000 });
  expect(result.resumed).toEqual([]);
  db.close();
});

test("terminated maestro session blocks resuming", () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const nowMs = 5_000;
  const taskId = insertTask(db, bus);
  insertDeferredEvent(db, taskId, 1_000, 4_000);
  const sessions = new MaestroSessionWriter({ db, now: (): number => nowMs });
  sessions.start({
    task_id: taskId,
    chain_handoff_id: "h-4",
    agent_id: "claude",
    wall_clock_budget_ms: 1000,
    cost_budget_cents: 1,
    sub_dispatch_budget: 1,
  });
  sessions.terminate(taskId, "cancelled");

  const result = runOrchestrateDeferralSweep({ db, bus, now: () => nowMs });
  expect(result.resumed).toEqual([]);
  db.close();
});

test("existing orchestrate_resumed blocks double fire", () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const taskId = insertTask(db, bus);
  insertDeferredEvent(db, taskId, 1_000, 4_000);
  db.query<unknown, [string, number, string]>(
    `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
     VALUES (?, ?, 'orchestrate_resumed', NULL, ?)`,
  ).run(taskId, 2_000, JSON.stringify({ resumed_at_ms: 2_000 }));

  const result = runOrchestrateDeferralSweep({ db, bus, now: () => 5_000 });
  expect(result.resumed).toEqual([]);
  db.close();
});
