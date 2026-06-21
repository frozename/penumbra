import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { migrate } from "../../src/db/migrations.js";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { PlanAlreadyRegistered, PlanTaskNotFound, PlanWriter } from "../../src/plans/writer.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function makeDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeWriter(db: Database, now = 1_700_000_000): PlanWriter {
  return new PlanWriter(db, () => now);
}

test("register happy path", () => {
  const db = makeDb();
  const w = makeWriter(db, 1_700_000_000);
  const plan = w.register({
    plan_id: "plan-a",
    file_path: "docs/plans/plan-a.md",
    home_project: "penumbra",
    tasks: [
      { task_meta_id: "1.1", project_id: "penumbra" },
      { task_meta_id: "1.2", project_id: "fleet" },
    ],
  });

  expect(plan.plan_id).toBe("plan-a");
  expect(plan.status).toBe("running");
  expect(plan.registered_at).toBe(1_700_000_000);
  expect(plan.home_project).toBe("penumbra");

  const tasks = w.getTasks("plan-a");
  expect(tasks.length).toBe(2);
  expect(tasks[0]!.task_meta_id).toBe("1.1");
  expect(tasks[0]!.status).toBe("pending");
  expect(tasks[0]!.task_id_in_board).toBeNull();
  expect(tasks[0]!.last_event_ts).toBeNull();
  expect(tasks[1]!.task_meta_id).toBe("1.2");
  expect(tasks[1]!.project_id).toBe("fleet");
});

test("register collision throws PlanAlreadyRegistered", () => {
  const db = makeDb();
  const w = makeWriter(db);
  w.register({
    plan_id: "plan-dup",
    file_path: "docs/plans/dup.md",
    home_project: "penumbra",
    tasks: [{ task_meta_id: "1.1", project_id: "penumbra" }],
  });
  expect(() =>
    w.register({
      plan_id: "plan-dup",
      file_path: "docs/plans/dup.md",
      home_project: "penumbra",
      tasks: [{ task_meta_id: "1.1", project_id: "penumbra" }],
    }),
  ).toThrow(PlanAlreadyRegistered);
});

test("bindTaskToBoard sets id + flips pending→running", () => {
  const db = makeDb();
  const w = makeWriter(db);
  w.register({
    plan_id: "plan-b",
    file_path: "docs/plans/plan-b.md",
    home_project: "penumbra",
    tasks: [{ task_meta_id: "2.1", project_id: "penumbra" }],
  });

  w.bindTaskToBoard("plan-b", "2.1", "task-board-uuid-1");

  const tasks = w.getTasks("plan-b");
  expect(tasks[0]!.task_id_in_board).toBe("task-board-uuid-1");
  expect(tasks[0]!.status).toBe("running");
});

test("bindTaskToBoard is idempotent when called twice", () => {
  const db = makeDb();
  const w = makeWriter(db);
  w.register({
    plan_id: "plan-c",
    file_path: "docs/plans/plan-c.md",
    home_project: "penumbra",
    tasks: [{ task_meta_id: "3.1", project_id: "penumbra" }],
  });

  w.bindTaskToBoard("plan-c", "3.1", "first-board-id");
  // second call with a different id should be a no-op
  w.bindTaskToBoard("plan-c", "3.1", "second-board-id");

  const tasks = w.getTasks("plan-c");
  expect(tasks[0]!.task_id_in_board).toBe("first-board-id");
  expect(tasks[0]!.status).toBe("running");

  // calling for a missing task should throw
  expect(() => {
    w.bindTaskToBoard("plan-c", "nope", "x");
  }).toThrow(PlanTaskNotFound);
});

test("markTaskStatus updates row + last_event_ts", () => {
  const db = makeDb();
  const w = makeWriter(db);
  w.register({
    plan_id: "plan-d",
    file_path: "docs/plans/plan-d.md",
    home_project: "penumbra",
    tasks: [{ task_meta_id: "4.1", project_id: "penumbra" }],
  });

  w.markTaskStatus("plan-d", "4.1", "completed", 1_700_005_000);
  const tasks = w.getTasks("plan-d");
  expect(tasks[0]!.status).toBe("completed");
  expect(tasks[0]!.last_event_ts).toBe(1_700_005_000);

  expect(() => {
    w.markTaskStatus("plan-d", "missing", "failed");
  }).toThrow(PlanTaskNotFound);
});

test("listPlans filter by status", () => {
  const db = makeDb();
  const w = makeWriter(db, 1_700_000_000);
  w.register({
    plan_id: "plan-running",
    file_path: "r.md",
    home_project: "penumbra",
    tasks: [{ task_meta_id: "1.1", project_id: "penumbra" }],
  });
  // bump now() so registered_at differs and DESC ordering is stable
  const w2 = new PlanWriter(db, () => 1_700_001_000);
  w2.register({
    plan_id: "plan-done",
    file_path: "d.md",
    home_project: "penumbra",
    tasks: [{ task_meta_id: "1.1", project_id: "penumbra" }],
  });
  w2.markPlanStatus("plan-done", "completed");

  const all = w.listPlans();
  expect(all.map((p) => p.plan_id)).toEqual(["plan-done", "plan-running"]);

  const running = w.listPlans({ status: "running" });
  expect(running.map((p) => p.plan_id)).toEqual(["plan-running"]);

  const completed = w.listPlans({ status: "completed" });
  expect(completed.map((p) => p.plan_id)).toEqual(["plan-done"]);
});

test("findPlanTaskByBoardId hit + miss", () => {
  const db = makeDb();
  const w = makeWriter(db);
  w.register({
    plan_id: "plan-find",
    file_path: "f.md",
    home_project: "penumbra",
    tasks: [
      { task_meta_id: "1.1", project_id: "penumbra" },
      { task_meta_id: "1.2", project_id: "fleet" },
    ],
  });
  w.bindTaskToBoard("plan-find", "1.2", "board-xyz");

  const hit = w.findPlanTaskByBoardId("board-xyz");
  expect(hit).toEqual({ plan_id: "plan-find", task_meta_id: "1.2" });

  const miss = w.findPlanTaskByBoardId("does-not-exist");
  expect(miss).toBeNull();
});

test("register transactional rollback on mid-task INSERT failure", () => {
  const db = makeDb();
  const w = makeWriter(db);

  // Pre-seed a different plan that owns one of the task PKs we're about to insert.
  // Since plan_tasks PK is (plan_id, task_meta_id), we instead force collision by
  // pre-inserting a row under the SAME plan_id we're about to register. We cheat
  // by inserting directly into plan_tasks with a foreign-key-violating plan_id
  // is not possible (FK ON), so seed a placeholder plan and a plan_tasks row
  // that collides with the second task we'll try to register.
  db.query<unknown, [string, string, string, number, string]>(
    `INSERT INTO plans (plan_id, file_path, home_project, registered_at, status)
     VALUES (?, ?, ?, ?, 'running')`,
  ).run("plan-rollback", "pre.md", "penumbra", 1_699_000_000);
  db.query<unknown, [string, string, string, string]>(
    `INSERT INTO plan_tasks (plan_id, task_meta_id, project_id, status)
     VALUES (?, ?, ?, 'pending')`,
  ).run("plan-rollback", "1.2", "penumbra");

  // Now delete the placeholder plan row so the register() call's collision check
  // on plans passes — but the orphaned plan_tasks row remains to collide later.
  db.query("PRAGMA foreign_keys = OFF").run();
  db.query<unknown, [string]>("DELETE FROM plans WHERE plan_id = ?").run("plan-rollback");
  db.query("PRAGMA foreign_keys = ON").run();

  expect(() =>
    w.register({
      plan_id: "plan-rollback",
      file_path: "rb.md",
      home_project: "penumbra",
      tasks: [
        { task_meta_id: "1.1", project_id: "penumbra" },
        { task_meta_id: "1.2", project_id: "penumbra" }, // collides with pre-seeded
      ],
    }),
  ).toThrow();

  // plan row should NOT exist after rollback
  const planRow = db
    .query<{ plan_id: string } | null, [string]>("SELECT plan_id FROM plans WHERE plan_id = ?")
    .get("plan-rollback");
  expect(planRow).toBeNull();

  // first task insert should also have rolled back; only the pre-seeded 1.2 remains
  const taskRows = db
    .query<
      { task_meta_id: string },
      [string]
    >("SELECT task_meta_id FROM plan_tasks WHERE plan_id = ? ORDER BY task_meta_id")
    .all("plan-rollback");
  expect(taskRows.map((r) => r.task_meta_id)).toEqual(["1.2"]);
});
