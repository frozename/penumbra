import {
  type FileTaskInput,
  loadSqliteVec,
  migrate,
  OrchestrateAgentNotMaestroCapable,
  PlanWriter,
  TaskEventBus,
  TaskWriter,
  type WorktreeManager,
} from "@penumbra/core";
import { createPlanRuntimeSweeper } from "@src/sweepers/plan-runtime.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {
  // Optional Homebrew SQLite is unavailable on non-local runners.
}

interface ParsedPlanHeader {
  home_project: string;
  plan_defaults?: {
    bounds?: {
      cost_cents: number;
      max_sub_dispatches: number;
      wall_clock_ms: number;
    };
  };
  plan_id: string;
}

interface ParsedPlanTask {
  body?: string;
  depends_on: string[];
  fallback_agent?: string;
  file_scope: string;
  files: string[];
  heading?: string;
  id: string;
  preferred_agent: string;
  project?: string;
  risk_class: string;
  task_size: string;
}

interface ParsedPlan {
  errors: string[];
  header: ParsedPlanHeader;
  tasks: ParsedPlanTask[];
}

interface LogEntry {
  meta?: unknown;
  msg: string;
}

interface StageCall {
  ancestorRefs: string[];
  handoffId: string;
  opts?: { project_id?: string };
}

interface StageMergedBaseMock {
  stageMergedBase(
    handoffId: string,
    ancestorRefs: string[],
    opts?: { project_id?: string },
  ): Promise<string>;
}

function makeDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makePlanFile(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "plan-runtime-"));
  const path = join(root, name);
  writeFileSync(path, "# plan\n", "utf8");
  return path;
}

function fakeParser(header: ParsedPlanHeader, tasks: ParsedPlanTask[]): () => Promise<ParsedPlan> {
  return () => Promise.resolve({ header, tasks, errors: [] });
}

function makeTaskWriter(db: Database): TaskWriter {
  return new TaskWriter(db, {
    bus: new TaskEventBus(),
    resolveAgent: (name: string) => ({ name, maestro_capable: true }),
  });
}

class CapturingTaskWriter extends TaskWriter {
  constructor(
    db: Database,
    private readonly capture: FileTaskInput[],
  ) {
    super(db, {
      bus: new TaskEventBus(),
      resolveAgent: (name: string) => ({ name, maestro_capable: true }),
    });
  }

  override file(input: FileTaskInput): { task_id: string } {
    this.capture.push(input);
    return super.file(input);
  }
}

function makeCapturingTaskWriter(db: Database, capture: FileTaskInput[]): TaskWriter {
  return new CapturingTaskWriter(db, capture);
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

class ThrowingTaskWriter extends TaskWriter {
  constructor(
    db: Database,
    private readonly error: Error,
  ) {
    super(db, {
      bus: new TaskEventBus(),
      resolveAgent: (name: string) => ({ name, maestro_capable: true }),
    });
  }

  override file(_input: FileTaskInput): { task_id: string } {
    throw this.error;
  }
}

class FlakyTaskWriter extends TaskWriter {
  callCount = 0;

  constructor(db: Database) {
    super(db, {
      bus: new TaskEventBus(),
      resolveAgent: (name: string) => ({ name, maestro_capable: true }),
    });
  }

  override file(input: FileTaskInput): { task_id: string } {
    this.callCount += 1;
    if (this.callCount === 1) throw new Error("transient");
    return super.file(input);
  }
}

class PromptCapturingTaskWriter extends TaskWriter {
  constructor(
    db: Database,
    private readonly prompts: string[],
  ) {
    super(db, {
      bus: new TaskEventBus(),
      resolveAgent: (name: string) => ({ name, maestro_capable: true }),
    });
  }

  override file(input: FileTaskInput): { task_id: string } {
    this.prompts.push(input.prompt);
    return super.file(input);
  }
}

function makeThrowingTaskWriter(db: Database, error: Error): TaskWriter {
  return new ThrowingTaskWriter(db, error);
}

function asWorktreeManager(mock: StageMergedBaseMock): WorktreeManager {
  // createPlanRuntimeSweeper only calls stageMergedBase; the concrete class has unrelated state.
  return mock as unknown as WorktreeManager;
}

function makeWorktreeManagerMock(): { calls: StageCall[]; mock: WorktreeManager } {
  const calls: StageCall[] = [];
  const mock: StageMergedBaseMock = {
    stageMergedBase: (
      handoffId: string,
      ancestorRefs: string[],
      opts?: { project_id?: string },
    ): Promise<string> => {
      calls.push({ handoffId, ancestorRefs: [...ancestorRefs], opts });
      return Promise.resolve(`stage/${handoffId}`);
    },
  };
  return { mock: asWorktreeManager(mock), calls };
}

const baseTask = {
  files: ["x.ts"],
  file_scope: "new",
  parallel_with: [],
  preferred_agent: "codex-acp-fast",
  fallback_agent: "claude-acp-sonnet",
  task_size: "small",
  risk_class: "paste-ready",
} satisfies Omit<ParsedPlanTask, "depends_on" | "id">;

test("single root fires once + idempotent across ticks", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeTaskWriter(db);
  const logs: LogEntry[] = [];
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
    log: { warn: (msg: string, meta?: unknown) => logs.push({ msg, meta }) },
    planParser: fakeParser({ plan_id: "p1", home_project: "penumbra" }, [
      { ...baseTask, id: "1.1", depends_on: [] },
    ]),
  });

  const r1 = await sweeper.tick();
  expect(r1.fired).toEqual(["1.1"]);
  const r2 = await sweeper.tick();
  expect(r2.fired).toEqual([]);
});

test("chained 1.1 → 1.2", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeTaskWriter(db);
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
  const r1 = await sweeper.tick();
  expect(r1.fired).toEqual(["1.1"]);
  plans.markTaskStatus("p1", "1.1", "completed");
  const r2 = await sweeper.tick();
  expect(r2.fired).toEqual(["1.2"]);
});

test("cross-project deps", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeTaskWriter(db);
  plans.register({
    plan_id: "p1",
    file_path: makePlanFile("p1.md"),
    home_project: "penumbra",
    tasks: [
      { task_meta_id: "1.1", project_id: "penumbra" },
      { task_meta_id: "1.2", project_id: "sirius" },
    ],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    planParser: fakeParser({ plan_id: "p1", home_project: "penumbra" }, [
      { ...baseTask, id: "1.1", depends_on: [], project: "penumbra" },
      { ...baseTask, id: "1.2", depends_on: ["penumbra/1.1"], project: "sirius" },
    ]),
  });
  const r1 = await sweeper.tick();
  expect(r1.fired).toEqual(["1.1"]);
  plans.markTaskStatus("p1", "1.1", "completed");
  const r2 = await sweeper.tick();
  expect(r2.fired).toEqual(["1.2"]);
  const sirius = plans.getTasks("p1").find((t) => t.task_meta_id === "1.2");
  expect(sirius?.project_id).toBe("sirius");
});

test("single same-project dep threads branch_base to the filed orchestrate task", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const calls: FileTaskInput[] = [];
  const taskWriter = makeCapturingTaskWriter(db, calls);
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

  await sweeper.tick();
  const planTask11 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.1");
  expect(planTask11?.task_id_in_board).toBeDefined();
  seedMaestroSession(db, planTask11!.task_id_in_board!, "h-root-1");
  plans.markTaskStatus("p1", "1.1", "completed");

  await sweeper.tick();
  expect(calls[1]?.branch_base).toBe("agent/h-root-1");
});

test("cross-project direct dep can branch off a transitive same-project ancestor", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const calls: FileTaskInput[] = [];
  const taskWriter = makeCapturingTaskWriter(db, calls);
  plans.register({
    plan_id: "p1",
    file_path: makePlanFile("p1.md"),
    home_project: "penumbra",
    tasks: [
      { task_meta_id: "1.1", project_id: "penumbra" },
      { task_meta_id: "1.2", project_id: "sirius" },
      { task_meta_id: "1.3", project_id: "penumbra" },
    ],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    planParser: fakeParser({ plan_id: "p1", home_project: "penumbra" }, [
      { ...baseTask, id: "1.1", depends_on: [] },
      { ...baseTask, id: "1.2", depends_on: ["penumbra/1.1"], project: "sirius" },
      { ...baseTask, id: "1.3", depends_on: ["sirius/1.2"] },
    ]),
  });

  await sweeper.tick();
  const planTask11 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.1");
  const planTask12 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.2");
  seedMaestroSession(db, planTask11!.task_id_in_board!, "h-root-1");
  plans.markTaskStatus("p1", "1.1", "completed");

  await sweeper.tick();
  seedMaestroSession(db, planTask12!.task_id_in_board!, "h-cross-1");
  plans.markTaskStatus("p1", "1.2", "completed");
  await sweeper.tick();
  expect(calls[2]?.branch_base).toBe("agent/h-root-1");
});

test("transitive same-project ancestors warn and choose the latest completed ancestor", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const calls: FileTaskInput[] = [];
  const logs: LogEntry[] = [];
  const taskWriter = makeCapturingTaskWriter(db, calls);
  plans.register({
    plan_id: "p1",
    file_path: makePlanFile("p1.md"),
    home_project: "penumbra",
    tasks: [
      { task_meta_id: "1.1", project_id: "penumbra" },
      { task_meta_id: "1.2", project_id: "sirius" },
      { task_meta_id: "1.3", project_id: "penumbra" },
      { task_meta_id: "1.4", project_id: "penumbra" },
    ],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    log: { warn: (msg: string, meta?: unknown) => logs.push({ msg, meta }) },
    planParser: fakeParser({ plan_id: "p1", home_project: "penumbra" }, [
      { ...baseTask, id: "1.1", depends_on: [] },
      { ...baseTask, id: "1.2", depends_on: ["penumbra/1.1"], project: "sirius" },
      { ...baseTask, id: "1.3", depends_on: [] },
      { ...baseTask, id: "1.4", depends_on: ["1.3", "sirius/1.2"] },
    ]),
  });

  await sweeper.tick();
  const task11 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.1");
  const task13 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.3");
  const task12 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.2");
  seedMaestroSession(db, task11!.task_id_in_board!, "h-root-1");
  seedMaestroSession(db, task13!.task_id_in_board!, "h-root-3");
  plans.markTaskStatus("p1", "1.1", "completed");
  plans.markTaskStatus("p1", "1.3", "completed");

  await sweeper.tick();
  seedMaestroSession(db, task12!.task_id_in_board!, "h-cross-1");
  plans.markTaskStatus("p1", "1.2", "completed");
  await sweeper.tick();
  expect(calls[3]?.branch_base).toBe("agent/h-root-3");
  expect(logs.some((entry) => entry.msg.includes("multiple same-project ancestors"))).toBe(true);
});

test("incomplete same-project ancestor does not become branch_base", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const calls: FileTaskInput[] = [];
  const taskWriter = makeCapturingTaskWriter(db, calls);
  plans.register({
    plan_id: "p1",
    file_path: makePlanFile("p1.md"),
    home_project: "penumbra",
    tasks: [
      { task_meta_id: "1.1", project_id: "penumbra" },
      { task_meta_id: "1.2", project_id: "sirius" },
      { task_meta_id: "1.3", project_id: "penumbra" },
    ],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    planParser: fakeParser({ plan_id: "p1", home_project: "penumbra" }, [
      { ...baseTask, id: "1.1", depends_on: [] },
      { ...baseTask, id: "1.2", depends_on: ["penumbra/1.1"], project: "sirius" },
      { ...baseTask, id: "1.3", depends_on: ["sirius/1.2"] },
    ]),
  });

  await sweeper.tick();
  const planTask11 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.1");
  const planTask12 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.2");
  seedMaestroSession(db, planTask11!.task_id_in_board!, "h-root-1");
  seedMaestroSession(db, planTask12!.task_id_in_board!, "h-cross-1");
  plans.markTaskStatus("p1", "1.1", "completed");

  await sweeper.tick();
  expect(calls[2]?.branch_base).toBeUndefined();
});

test("multi same-project deps warn and choose the latest completed ancestor", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const calls: FileTaskInput[] = [];
  const logs: LogEntry[] = [];
  const taskWriter = makeCapturingTaskWriter(db, calls);
  plans.register({
    plan_id: "p1",
    file_path: makePlanFile("p1.md"),
    home_project: "penumbra",
    tasks: [
      { task_meta_id: "1.1", project_id: "penumbra" },
      { task_meta_id: "1.2", project_id: "sirius" },
      { task_meta_id: "1.3", project_id: "penumbra" },
      { task_meta_id: "1.4", project_id: "penumbra" },
    ],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    log: { warn: (msg: string, meta?: unknown) => logs.push({ msg, meta }) },
    planParser: fakeParser({ plan_id: "p1", home_project: "penumbra" }, [
      { ...baseTask, id: "1.1", depends_on: [] },
      { ...baseTask, id: "1.2", depends_on: ["penumbra/1.1"], project: "sirius" },
      { ...baseTask, id: "1.3", depends_on: [] },
      { ...baseTask, id: "1.4", depends_on: ["1.3", "sirius/1.2"] },
    ]),
  });

  await sweeper.tick();
  const planTask11 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.1");
  const planTask12 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.2");
  const planTask13 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.3");
  seedMaestroSession(db, planTask11!.task_id_in_board!, "h-1");
  seedMaestroSession(db, planTask13!.task_id_in_board!, "h-3");
  expect(calls[0]?.branch_base).toBeUndefined();
  expect(calls[1]?.branch_base).toBeUndefined();
  plans.markTaskStatus("p1", "1.1", "completed");
  plans.markTaskStatus("p1", "1.3", "completed");
  await sweeper.tick();
  seedMaestroSession(db, planTask12!.task_id_in_board!, "h-2");
  plans.markTaskStatus("p1", "1.2", "completed");
  await sweeper.tick();
  expect(calls[3]?.branch_base).toBe("agent/h-3");
  expect(logs.some((entry) => entry.msg.includes("multiple same-project ancestors"))).toBe(true);
});

test("multi same-project fan-in stages a merged base and uses the returned ref", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const calls: FileTaskInput[] = [];
  const logs: LogEntry[] = [];
  const taskWriter = makeCapturingTaskWriter(db, calls);
  const { mock: worktreeManager, calls: stageCalls } = makeWorktreeManagerMock();
  plans.register({
    plan_id: "p1",
    file_path: makePlanFile("p1.md"),
    home_project: "penumbra",
    tasks: [
      { task_meta_id: "1.1", project_id: "penumbra" },
      { task_meta_id: "1.2", project_id: "sirius" },
      { task_meta_id: "1.3", project_id: "penumbra" },
      { task_meta_id: "1.4", project_id: "penumbra" },
    ],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    log: { warn: (msg: string, meta?: unknown) => logs.push({ msg, meta }) },
    worktreeManager,
    planParser: fakeParser({ plan_id: "p1", home_project: "penumbra" }, [
      { ...baseTask, id: "1.1", depends_on: [] },
      { ...baseTask, id: "1.2", depends_on: ["penumbra/1.1"], project: "sirius" },
      { ...baseTask, id: "1.3", depends_on: [] },
      { ...baseTask, id: "1.4", depends_on: ["1.3", "sirius/1.2"] },
    ]),
  });

  await sweeper.tick();
  const task11 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.1");
  const task13 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.3");
  const task12 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.2");
  seedMaestroSession(db, task11!.task_id_in_board!, "h-root-1");
  seedMaestroSession(db, task13!.task_id_in_board!, "h-root-3");
  plans.markTaskStatus("p1", "1.1", "completed");
  plans.markTaskStatus("p1", "1.3", "completed");

  await sweeper.tick();
  seedMaestroSession(db, task12!.task_id_in_board!, "h-cross-1");
  plans.markTaskStatus("p1", "1.2", "completed");
  await sweeper.tick();

  expect(stageCalls[0]?.handoffId).toBe("p1__1.4");
  expect(stageCalls[0]?.ancestorRefs).toEqual(["agent/h-root-3", "agent/h-root-1"]);
  expect(stageCalls[0]?.opts).toEqual({ project_id: "penumbra" });
  expect(calls[3]?.branch_base).toBe("stage/p1__1.4");
  expect(logs.some((entry) => entry.msg.includes("multiple same-project ancestors"))).toBe(true);
});

test("multi same-project fan-in falls back when merge staging fails", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const calls: FileTaskInput[] = [];
  const logs: LogEntry[] = [];
  const taskWriter = makeCapturingTaskWriter(db, calls);
  const worktreeManager = asWorktreeManager({
    stageMergedBase: (): Promise<string> => Promise.reject(new Error("merge conflict")),
  });
  plans.register({
    plan_id: "p1",
    file_path: makePlanFile("p1.md"),
    home_project: "penumbra",
    tasks: [
      { task_meta_id: "1.1", project_id: "penumbra" },
      { task_meta_id: "1.2", project_id: "sirius" },
      { task_meta_id: "1.3", project_id: "penumbra" },
      { task_meta_id: "1.4", project_id: "penumbra" },
    ],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    log: { warn: (msg: string, meta?: unknown) => logs.push({ msg, meta }) },
    worktreeManager,
    planParser: fakeParser({ plan_id: "p1", home_project: "penumbra" }, [
      { ...baseTask, id: "1.1", depends_on: [] },
      { ...baseTask, id: "1.2", depends_on: ["penumbra/1.1"], project: "sirius" },
      { ...baseTask, id: "1.3", depends_on: [] },
      { ...baseTask, id: "1.4", depends_on: ["1.3", "sirius/1.2"] },
    ]),
  });

  await sweeper.tick();
  const task11 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.1");
  const task13 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.3");
  const task12 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.2");
  seedMaestroSession(db, task11!.task_id_in_board!, "h-root-1");
  seedMaestroSession(db, task13!.task_id_in_board!, "h-root-3");
  plans.markTaskStatus("p1", "1.1", "completed");
  plans.markTaskStatus("p1", "1.3", "completed");

  await sweeper.tick();
  seedMaestroSession(db, task12!.task_id_in_board!, "h-cross-1");
  plans.markTaskStatus("p1", "1.2", "completed");
  await sweeper.tick();

  expect(calls[3]?.branch_base).toBe("agent/h-root-3");
  expect(logs.some((entry) => entry.msg.includes("merge conflict"))).toBe(true);
});

test("failure flips plan to failed and stops firing pending", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeTaskWriter(db);
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
      { ...baseTask, id: "1.2", depends_on: [] },
    ]),
  });
  await sweeper.tick();
  const planTask11 = plans.getTasks("p1").find((t) => t.task_meta_id === "1.1");
  seedMaestroSession(db, planTask11!.task_id_in_board!, "h-complete");
  plans.markTaskStatus("p1", "1.1", "failed");
  await sweeper.tick();
  expect(plans.getPlan("p1")?.status).toBe("failed");
});

test("cancelled plan → pending skipped", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeTaskWriter(db);
  plans.register({
    plan_id: "p1",
    file_path: makePlanFile("p1.md"),
    home_project: "penumbra",
    tasks: [{ task_meta_id: "1.1", project_id: "penumbra" }],
  });
  plans.markPlanStatus("p1", "cancelled");
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    planParser: fakeParser({ plan_id: "p1", home_project: "penumbra" }, [
      { ...baseTask, id: "1.1", depends_on: [] },
    ]),
  });
  const r = await sweeper.tick();
  expect(r.fired).toEqual([]);
});

test("completion flips plan to completed", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeTaskWriter(db);
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
  await sweeper.tick();
  plans.markTaskStatus("p1", "1.1", "completed");
  await sweeper.tick();
  expect(plans.getPlan("p1")?.status).toBe("completed");
});

test("transient taskWriter.file failure → row fails and does not retry", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const flakyTaskWriter = new FlakyTaskWriter(db);
  plans.register({
    plan_id: "p1",
    file_path: makePlanFile("p1.md"),
    home_project: "penumbra",
    tasks: [{ task_meta_id: "1.1", project_id: "penumbra" }],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter: flakyTaskWriter,
    planParser: fakeParser({ plan_id: "p1", home_project: "penumbra" }, [
      { ...baseTask, id: "1.1", depends_on: [] },
    ]),
  });
  const r1 = await sweeper.tick();
  expect(r1.fired).toEqual([]);
  expect(plans.getTasks("p1")[0]?.status).toBe("failed");
  const r2 = await sweeper.tick();
  expect(r2.fired).toEqual([]);
});

test("unknown agent failure marks task failed and logs not found", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const logs: LogEntry[] = [];
  const taskWriter = makeThrowingTaskWriter(
    db,
    new OrchestrateAgentNotMaestroCapable("ghost-agent", "unknown"),
  );
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
    log: { warn: (msg: string, meta?: unknown) => logs.push({ msg, meta }) },
    planParser: fakeParser({ plan_id: "p1", home_project: "penumbra" }, [
      {
        ...baseTask,
        id: "1.1",
        preferred_agent: "ghost-agent",
        fallback_agent: undefined,
        depends_on: [],
      },
    ]),
  });

  await sweeper.tick();
  expect(plans.getTasks("p1")[0]?.status).toBe("failed");
  expect(logs.length).toBeGreaterThan(0);
});

test("not maestro-capable failure marks task failed and logs guidance", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const logs: LogEntry[] = [];
  const taskWriter = makeThrowingTaskWriter(
    db,
    new OrchestrateAgentNotMaestroCapable("codex-acp-fast", "not_maestro_capable"),
  );
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
    log: { warn: (msg: string, meta?: unknown) => logs.push({ msg, meta }) },
    planParser: fakeParser({ plan_id: "p1", home_project: "penumbra" }, [
      {
        ...baseTask,
        id: "1.1",
        preferred_agent: "codex-acp-fast",
        fallback_agent: "claude-acp-sonnet",
        depends_on: [],
      },
    ]),
  });

  await sweeper.tick();
  expect(plans.getTasks("p1")[0]?.status).toBe("failed");
  expect(logs.length).toBeGreaterThan(0);
});

test("leaf failure cascades plan to failed on subsequent tick", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeThrowingTaskWriter(
    db,
    new OrchestrateAgentNotMaestroCapable("codex-acp-fast", "not_maestro_capable"),
  );
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
      {
        ...baseTask,
        id: "1.1",
        preferred_agent: "codex-acp-fast",
        fallback_agent: "claude-acp-sonnet",
        depends_on: [],
      },
    ]),
  });

  await sweeper.tick();
  expect(plans.getTasks("p1")[0]?.status).toBe("failed");
  await sweeper.tick();
  expect(plans.getPlan("p1")?.status).toBe("failed");
});

test("inlines task body into the dispatched prompt", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const prompts: string[] = [];
  const taskWriter = new PromptCapturingTaskWriter(db, prompts);
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
      {
        ...baseTask,
        id: "1.1",
        heading: "Task 1.1 - First",
        body: "First body line.",
        depends_on: [],
      },
    ]),
  });

  await sweeper.tick();
  expect(prompts[0]).toContain("First body line.");
  expect(prompts[0]).toContain("Task: Task 1.1 - First");
});

test("omits undefined body text from the dispatched prompt", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const prompts: string[] = [];
  const taskWriter = new PromptCapturingTaskWriter(db, prompts);
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
      {
        ...baseTask,
        id: "1.1",
        depends_on: [],
      },
    ]),
  });

  await sweeper.tick();
  expect(prompts[0]).toContain("Implement Task 1.1 of plan p1.");
  expect(prompts[0]).not.toContain("undefined");
});

test("running plan with missing file is quarantined (fail-closed) and not re-parsed on subsequent ticks", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeTaskWriter(db);
  const missingPath = join(mkdtempSync(join(tmpdir(), "plan-runtime-missing-")), "gone.md");
  plans.register({
    plan_id: "p-missing",
    file_path: missingPath, // never written to disk
    home_project: "penumbra",
    tasks: [{ task_meta_id: "1.1", project_id: "penumbra" }],
  });

  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    planParser: fakeParser({ plan_id: "p-missing", home_project: "penumbra" }, [
      { ...baseTask, id: "1.1", depends_on: [] },
    ]),
  });

  const r1 = await sweeper.tick();
  expect(r1.fired).toEqual([]);
  expect(plans.getPlan("p-missing")?.status).toBe("failed");
  expect(plans.listPlans({ status: "running" })).toEqual([]);

  const countAfterFirst = db
    .query<
      { count: number },
      [string, string]
    >("SELECT COUNT(*) as count FROM dispatch_events WHERE handoff_id = ? AND kind = ?")
    .get("p-missing", "plan.quarantined");
  expect(countAfterFirst?.count).toBe(1);

  // Second tick must not re-parse or re-quarantine - this is the hot-loop pin.
  const r2 = await sweeper.tick();
  expect(r2.fired).toEqual([]);
  const countAfterSecond = db
    .query<
      { count: number },
      [string, string]
    >("SELECT COUNT(*) as count FROM dispatch_events WHERE handoff_id = ? AND kind = ?")
    .get("p-missing", "plan.quarantined");
  expect(countAfterSecond?.count).toBe(1);
});

test("transient (non-ENOENT) parse errors retry under threshold, then quarantine on the 3rd consecutive failure", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeTaskWriter(db);
  let parseCalls = 0;
  plans.register({
    plan_id: "p-flaky",
    file_path: makePlanFile("p-flaky.md"), // real file - failure comes from the parser, not readFile
    home_project: "penumbra",
    tasks: [{ task_meta_id: "1.1", project_id: "penumbra" }],
  });

  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    planParser: () => {
      parseCalls += 1;
      return Promise.reject(new Error("malformed plan meta"));
    },
  });

  await sweeper.tick();
  expect(plans.getPlan("p-flaky")?.status).toBe("running");
  await sweeper.tick();
  expect(plans.getPlan("p-flaky")?.status).toBe("running");
  await sweeper.tick();
  expect(plans.getPlan("p-flaky")?.status).toBe("failed");
  expect(parseCalls).toBe(3);

  const event = db
    .query<
      { count: number },
      [string, string]
    >("SELECT COUNT(*) as count FROM dispatch_events WHERE handoff_id = ? AND kind = ?")
    .get("p-flaky", "plan.quarantined");
  expect(event?.count).toBe(1);
});

test("quarantine warn passes context as pino's first positional arg (not dropped as an interpolation value)", async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeTaskWriter(db);
  const calls: unknown[][] = [];
  const missingPath = join(mkdtempSync(join(tmpdir(), "plan-runtime-missing-")), "gone.md");
  plans.register({
    plan_id: "p-missing-2",
    file_path: missingPath,
    home_project: "penumbra",
    tasks: [{ task_meta_id: "1.1", project_id: "penumbra" }],
  });

  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    // Raw rest-arg capture (not the file's usual (msg, meta) mock shape) so
    // this test observes real ARGUMENT POSITION, which is what pino cares about.
    log: { warn: (...args: unknown[]) => calls.push(args) },
    planParser: fakeParser({ plan_id: "p-missing-2", home_project: "penumbra" }, [
      { ...baseTask, id: "1.1", depends_on: [] },
    ]),
  });

  await sweeper.tick();
  expect(calls.length).toBeGreaterThan(0);
  const [firstArg, secondArg] = calls[0]!;
  expect(typeof firstArg).toBe("object");
  expect((firstArg as Record<string, unknown>).plan_id).toBe("p-missing-2");
  expect(typeof secondArg).toBe("string");
});
