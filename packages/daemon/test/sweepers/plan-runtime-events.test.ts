import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSqliteVec, migrate, PlanWriter, TaskWriter, TaskEventBus } from "@penumbra/core";
import { createPlanRuntimeSweeper } from "../../src/sweepers/plan-runtime.js";

try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {}

function makeDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makePlanFile(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "plan-runtime-events-"));
  const path = join(root, name);
  writeFileSync(path, "# plan\n", "utf8");
  return path;
}

function fakeParser(header: any, tasks: any[]) {
  return async (_path: string) => ({ header, tasks, errors: [] });
}

function makeTaskWriter(db: Database, bus: TaskEventBus): TaskWriter {
  return new TaskWriter(db, {
    bus,
    resolveAgent: (name: string) => ({ name, maestro_capable: true }),
  });
}

const baseTask = {
  files: ["x.ts"],
  file_scope: "new",
  parallel_with: [],
  preferred_agent: "codex-acp-fast",
  fallback_agent: "claude-acp-sonnet",
  task_size: "small",
  risk_class: "paste-ready",
};

test("completed event for bound plan-task flips its status", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const bus = new TaskEventBus();
  const taskWriter = makeTaskWriter(db, bus);

  plans.register({
    plan_id: "p1",
    file_path: makePlanFile("p1.md"),
    home_project: "penumbra",
    tasks: [{ task_meta_id: "1.1", project_id: "penumbra" }],
  });

  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    planParser: fakeParser({ plan_id: "p1", home_project: "penumbra" }, [
      { ...baseTask, id: "1.1", depends_on: [] },
    ]),
  });

  const unsub = sweeper.subscribe(bus);

  const r1 = await sweeper.tick();
  expect(r1.fired).toEqual(["1.1"]);
  const planTask = plans.getTasks("p1").find((t) => t.task_meta_id === "1.1");
  expect(planTask?.status).toBe("running");

  bus.publish({
    kind: "completed",
    task_id: planTask!.task_id_in_board!,
    at: Date.now(),
    actor: null,
    payload: null,
  });

  await new Promise((r) => setTimeout(r, 50));

  const updated = plans.getTasks("p1").find((t) => t.task_meta_id === "1.1");
  expect(updated?.status).toBe("completed");

  unsub();
});

test("completion immediately fires the next dep-met task (chained 1.1 → 1.2)", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const bus = new TaskEventBus();
  const taskWriter = makeTaskWriter(db, bus);

  plans.register({
    plan_id: "p1",
    file_path: makePlanFile("p1.md"),
    home_project: "penumbra",
    tasks: [
      { task_meta_id: "1.1", project_id: "penumbra" },
      { task_meta_id: "1.2", project_id: "penumbra" },
    ],
  });

  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    planParser: fakeParser({ plan_id: "p1", home_project: "penumbra" }, [
      { ...baseTask, id: "1.1", depends_on: [] },
      { ...baseTask, id: "1.2", depends_on: ["1.1"] },
    ]),
  });

  const unsub = sweeper.subscribe(bus);

  await sweeper.tick();
  const planTask11 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.1");
  expect(planTask11?.task_id_in_board).toBeDefined();

  bus.publish({
    kind: "completed",
    task_id: planTask11!.task_id_in_board!,
    at: Date.now(),
    actor: null,
    payload: null,
  });

  await new Promise((r) => setTimeout(r, 100));

  const planTask12 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.2");
  expect(planTask12?.status).toBe("running");
  expect(planTask12?.task_id_in_board).toBeDefined();

  unsub();
});
