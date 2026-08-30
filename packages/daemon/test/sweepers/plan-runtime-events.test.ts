import {
  type FileTaskInput,
  loadSqliteVec,
  migrate,
  PlanWriter,
  TaskEventBus,
  TaskWriter,
  type WorktreeManager,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPlanRuntimeSweeper } from "../../src/sweepers/plan-runtime.js";

try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {
  noop();
}

interface ParsedPlanHeader {
  home_project: string;
  plan_id: string;
}

interface ParsedPlanTask {
  depends_on: string[];
  fallback_agent?: string;
  file_scope: string;
  files: string[];
  id: string;
  preferred_agent: string;
  risk_class: string;
  task_size: string;
}

interface ParsedPlan {
  errors: string[];
  header: ParsedPlanHeader;
  tasks: ParsedPlanTask[];
}

function noop(): void {
  return undefined;
}

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

function fakeParser(header: ParsedPlanHeader, tasks: ParsedPlanTask[]): () => Promise<ParsedPlan> {
  return () => Promise.resolve({ header, tasks, errors: [] });
}

function makeTaskWriter(db: Database, bus: TaskEventBus): TaskWriter {
  return new TaskWriter(db, {
    bus,
    resolveAgent: (name: string) => ({ name, maestro_capable: true }),
  });
}

class CapturingTaskWriter extends TaskWriter {
  constructor(
    db: Database,
    bus: TaskEventBus,
    private readonly capture: FileTaskInput[],
  ) {
    super(db, {
      bus,
      resolveAgent: (name: string) => ({ name, maestro_capable: true }),
    });
  }

  override file(input: FileTaskInput): { task_id: string } {
    this.capture.push(input);
    return super.file(input);
  }
}

function makeCapturingTaskWriter(
  db: Database,
  bus: TaskEventBus,
  capture: FileTaskInput[],
): TaskWriter {
  return new CapturingTaskWriter(db, bus, capture);
}

function seedMaestroSession(db: Database, taskId: string, handoffId: string): void {
  db.run(
    `INSERT INTO maestro_sessions (
      task_id, chain_handoff_id, agent_id, started_at,
      wall_clock_budget_ms, cost_budget_cents, sub_dispatch_budget
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [taskId, handoffId, "agent", Date.now(), 1, 1, 1],
  );
}

function fileSeedTask(taskWriter: TaskWriter): string {
  return taskWriter.file({
    kind: "orchestrate",
    project_id: "penumbra",
    prompt: "seed task",
    created_by_kind: "workflow",
    created_by_id: "plan-runtime-test",
    eligibility: { allow_agents: ["codex-acp-fast"] },
    bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 1 },
  }).task_id;
}

function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
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

test("event tick coalesces while a sweep is in flight without double-firing or dropping the event", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const bus = new TaskEventBus();
  const filed: FileTaskInput[] = [];
  const setupTaskWriter = makeTaskWriter(db, bus);
  const taskWriter = makeCapturingTaskWriter(db, bus, filed);
  const stageRelease = makeDeferred();
  let stageCalls = 0;
  const worktreeManager = {
    async stageMergedBase(): Promise<string> {
      stageCalls += 1;
      await stageRelease.promise;
      return "stage/p1__1.9";
    },
  } as unknown as WorktreeManager;

  plans.register({
    plan_id: "p1",
    file_path: makePlanFile("p1.md"),
    home_project: "penumbra",
    tasks: [
      { task_meta_id: "1.1", project_id: "penumbra" },
      { task_meta_id: "1.2", project_id: "penumbra" },
      { task_meta_id: "1.7", project_id: "penumbra" },
      { task_meta_id: "1.8", project_id: "penumbra" },
      { task_meta_id: "1.9", project_id: "penumbra" },
    ],
  });
  const task11 = fileSeedTask(setupTaskWriter);
  const task17 = fileSeedTask(setupTaskWriter);
  const task18 = fileSeedTask(setupTaskWriter);
  plans.bindTaskToBoard("p1", "1.1", task11);
  plans.bindTaskToBoard("p1", "1.7", task17);
  plans.bindTaskToBoard("p1", "1.8", task18);
  plans.markTaskStatus("p1", "1.7", "completed");
  plans.markTaskStatus("p1", "1.8", "completed");
  seedMaestroSession(db, task11, "h-11");
  seedMaestroSession(db, task17, "h-17");
  seedMaestroSession(db, task18, "h-18");

  const parsedTasks = [
    { ...baseTask, id: "1.1", depends_on: [] },
    { ...baseTask, id: "1.2", depends_on: ["1.1"] },
    { ...baseTask, id: "1.7", depends_on: [] },
    { ...baseTask, id: "1.8", depends_on: [] },
    { ...baseTask, id: "1.9", depends_on: ["1.7", "1.8"] },
  ];
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    worktreeManager,
    planParser: fakeParser({ plan_id: "p1", home_project: "penumbra" }, parsedTasks),
  });
  const unsub = sweeper.subscribe(bus);

  const originalGetTasks = plans.getTasks.bind(plans);
  let publishedCompletion = false;
  (plans as { getTasks: PlanWriter["getTasks"] }).getTasks = (
    planId: string,
  ): ReturnType<PlanWriter["getTasks"]> => {
    const tasks = originalGetTasks(planId);
    if (!publishedCompletion) {
      publishedCompletion = true;
      bus.publish({
        kind: "completed",
        task_id: task11,
        at: Date.now(),
        actor: null,
        payload: null,
      });
    }
    return tasks;
  };

  const tick = sweeper.tick();
  await waitUntil(() => stageCalls >= 1);
  await Promise.race([
    waitUntil(() => stageCalls >= 2, 50).catch(() => undefined),
    new Promise((r) => setTimeout(r, 50)),
  ]);
  stageRelease.resolve();
  await tick;
  await waitUntil(
    () =>
      filed.some((input) => input.prompt.includes("Implement Task 1.2 ")) &&
      filed.some((input) => input.prompt.includes("Implement Task 1.9 ")),
  );
  await new Promise((r) => setTimeout(r, 25));

  const filedTask12 = filed.filter((input) => input.prompt.includes("Implement Task 1.2 "));
  const filedTask19 = filed.filter((input) => input.prompt.includes("Implement Task 1.9 "));
  expect(filedTask12).toHaveLength(1);
  expect(filedTask19).toHaveLength(1);

  unsub();
});
