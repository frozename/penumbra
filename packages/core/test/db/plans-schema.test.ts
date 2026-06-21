import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { migrate } from "../../src/db/migrations.js";
import { SCHEMA_VERSION } from "../../src/db/schema.js";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // platform-specific SQLite override; ignore failures elsewhere
}

test("schema_version matches current version after migrate", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const row = db.query("SELECT value FROM db_meta WHERE key='schema_version'").get() as {
    value: string;
  };
  expect(row.value).toBe(String(SCHEMA_VERSION));
});

test("plans + plan_tasks tables + indexes exist", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const plans = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='plans'")
    .get() as { name: string } | undefined;
  expect(plans?.name).toBe("plans");

  const planTasks = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_tasks'")
    .get() as { name: string } | undefined;
  expect(planTasks?.name).toBe("plan_tasks");

  const idx1 = db
    .query("SELECT name FROM sqlite_master WHERE type='index' AND name='plan_tasks_status'")
    .get() as { name: string } | undefined;
  expect(idx1?.name).toBe("plan_tasks_status");

  const idx2 = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='plan_tasks_task_id_in_board'",
    )
    .get() as { name: string } | undefined;
  expect(idx2?.name).toBe("plan_tasks_task_id_in_board");
});

test("round-trip insert + select on plans + plan_tasks", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const now = Date.now();
  db.run(
    `INSERT INTO plans(plan_id, file_path, home_project, registered_at, status) VALUES (?, ?, ?, ?, ?)`,
    ["plan-1", "/path/to/plan.md", "penumbra", now, "running"],
  );
  db.run(
    `INSERT INTO plan_tasks(plan_id, task_meta_id, project_id, task_id_in_board, status, last_event_ts) VALUES (?, ?, ?, ?, ?, ?)`,
    ["plan-1", "1.1", "penumbra", null, "pending", null],
  );

  const plan = db.query("SELECT plan_id, status FROM plans WHERE plan_id='plan-1'").get() as {
    plan_id: string;
    status: string;
  };
  expect(plan.status).toBe("running");

  const task = db
    .query("SELECT task_meta_id, status FROM plan_tasks WHERE plan_id='plan-1'")
    .get() as { task_meta_id: string; status: string };
  expect(task.status).toBe("pending");
});
