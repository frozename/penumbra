import type { AgentDescriptor } from "@penumbra/core";

import {
  loadSqliteVec,
  MaestroSessionWriter,
  migrate,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { createBoundsCallbacks } from "../../src/maestro/bounds-callbacks.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // Optional Homebrew SQLite is unavailable on non-local runners.
}

const MAESTRO_AGENT: AgentDescriptor = {
  name: "claude-acp-sonnet",
  maestro_capable: true,
  tags: ["typescript"],
  tier: "premium",
};

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

interface TaskHarness {
  db: Database;
  bus: TaskEventBus;
  taskWriter: TaskWriter;
  sessions: MaestroSessionWriter;
  setNowMs: (value: number) => void;
}

function createTaskHarness(nowMs = 1_000): TaskHarness {
  const db = setupDb();
  const bus = new TaskEventBus();
  let currentNow = nowMs;
  const taskWriter = new TaskWriter(db, {
    now: (): number => currentNow,
    bus,
    resolveAgent: (name): AgentDescriptor | undefined =>
      name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined,
  });
  const sessions = new MaestroSessionWriter({ db, now: (): number => currentNow });

  return {
    db,
    bus,
    taskWriter,
    sessions,
    setNowMs: (value): void => {
      currentNow = value;
    },
  };
}

function fileOrchestrateTask(
  taskWriter: TaskWriter,
  overrides: {
    requires_review?: boolean;
  } = {},
): string {
  return taskWriter.file({
    prompt: "coordinate this task",
    kind: "orchestrate",
    requires_review: overrides.requires_review,
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  }).task_id;
}

function seedSession(
  db: Database,
  input: {
    task_id: string;
    chain_handoff_id: string;
    started_at: number;
    wall_clock_budget_ms?: number;
    cost_budget_cents?: number;
    sub_dispatch_budget?: number;
    cost_consumed_cents?: number;
    sub_dispatches_consumed?: number;
  },
): void {
  db.query<unknown, [string, string, string, number, number, number, number, number, number]>(
    `INSERT INTO maestro_sessions (
      task_id, chain_handoff_id, agent_id, started_at,
      wall_clock_budget_ms, cost_budget_cents, sub_dispatch_budget,
      cost_consumed_cents, sub_dispatches_consumed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.task_id,
    input.chain_handoff_id,
    MAESTRO_AGENT.name,
    input.started_at,
    input.wall_clock_budget_ms ?? 100_000,
    input.cost_budget_cents ?? 200,
    input.sub_dispatch_budget ?? 10,
    input.cost_consumed_cents ?? 0,
    input.sub_dispatches_consumed ?? 0,
  );
}

type InjectFn = (chainHandoffId: string, message: { role: "user"; text: string }) => Promise<void>;
type ChainCancelFn = (chainHandoffId: string) => Promise<void>;

const noopInject: InjectFn = () => Promise.resolve();

afterEach(() => {
  mock.restore();
});

test("soft warn happy path: injects warning and appends orchestrate_warning event", async () => {
  const harness = createTaskHarness(1_000);
  try {
    const taskId = fileOrchestrateTask(harness.taskWriter);
    seedSession(harness.db, {
      task_id: taskId,
      chain_handoff_id: "h-soft-1",
      started_at: 0,
      wall_clock_budget_ms: 10_000,
      cost_budget_cents: 100,
      sub_dispatch_budget: 5,
      cost_consumed_cents: 30,
      sub_dispatches_consumed: 2,
    });

    const inject = mock<InjectFn>(() => Promise.resolve());
    const chainCancel = mock<ChainCancelFn>(() => Promise.resolve());

    const callbacks = createBoundsCallbacks({
      db: harness.db,
      taskWriter: harness.taskWriter,
      sessions: harness.sessions,
      injector: { inject },
      bus: harness.bus,
      chainCancel,
      now: () => 8_500,
    });

    const session = harness.sessions.get(taskId);
    expect(session).toBeTruthy();
    if (!session) throw new Error("session missing");
    callbacks.onSoftWarn(session);
    await Bun.sleep(0);

    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0]?.[0]).toBe("h-soft-1");
    const message = inject.mock.calls[0]?.[1];
    expect(message?.role).toBe("user");
    expect(message?.text).toContain("BUDGET WARNING");

    const row = harness.db
      .query<
        { payload_json: string | null },
        [string]
      >(`SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_warning' ORDER BY id DESC LIMIT 1`)
      .get(taskId);
    expect(row).toBeTruthy();
    const payload = JSON.parse(row?.payload_json ?? "{}") as {
      pct_consumed?: number;
      axis_breakdown?: {
        wall_clock?: number;
        cost?: number;
        sub_dispatches?: number;
        subscription_pressure?: number;
      };
      soft_warned_at?: number;
    };
    expect(payload.pct_consumed).toBeCloseTo(0.85, 4);
    expect(payload.axis_breakdown).toEqual({
      wall_clock: 0.85,
      cost: 0.3,
      sub_dispatches: 0.4,
      subscription_pressure: 0,
    });
    expect(payload.soft_warned_at).toBe(8_500);
    expect(chainCancel).not.toHaveBeenCalled();
  } finally {
    harness.db.close();
  }
});

test("hard kill with open lease: terminates session, fails task, appends event, and cancels chain", async () => {
  const harness = createTaskHarness(1_000);
  try {
    const taskId = fileOrchestrateTask(harness.taskWriter);
    const lease = harness.taskWriter.lease({ task_id: taskId, agent_id: MAESTRO_AGENT.name });
    seedSession(harness.db, {
      task_id: taskId,
      chain_handoff_id: "h-hard-1",
      started_at: 0,
      wall_clock_budget_ms: 10_000,
      cost_budget_cents: 100,
      sub_dispatch_budget: 5,
      cost_consumed_cents: 55,
      sub_dispatches_consumed: 3,
    });

    const inject = mock<InjectFn>(() => Promise.resolve());
    const chainCancel = mock<ChainCancelFn>(() => Promise.resolve());

    const callbacks = createBoundsCallbacks({
      db: harness.db,
      taskWriter: harness.taskWriter,
      sessions: harness.sessions,
      injector: { inject },
      bus: harness.bus,
      chainCancel,
      now: () => 10_500,
    });

    const session = harness.sessions.get(taskId);
    expect(session).toBeTruthy();
    if (!session) throw new Error("session missing");
    callbacks.onHardKill(session, "wall_clock");
    await Bun.sleep(0);

    const updatedSession = harness.sessions.get(taskId);
    expect(updatedSession?.termination_reason).toBe("bounds_exceeded:wall_clock");
    const task = harness.taskWriter.get(taskId);
    expect(task.status).toBe("failed");
    expect(task.failure_reason).toBe("bounds_exceeded:wall_clock");

    const leaseRow = harness.db
      .query<
        { released_at: number | null; release_reason: string | null },
        [string]
      >("SELECT released_at, release_reason FROM task_leases WHERE id = ?")
      .get(lease.lease_id);
    expect(leaseRow?.released_at).not.toBeNull();
    expect(leaseRow?.release_reason).toBe("failed");

    const row = harness.db
      .query<
        { payload_json: string | null },
        [string]
      >(`SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated' ORDER BY id DESC LIMIT 1`)
      .get(taskId);
    expect(row).toBeTruthy();
    const payload = JSON.parse(row?.payload_json ?? "{}") as {
      reason?: string;
      consumed?: { pct_consumed?: number; axis_breakdown?: Record<string, number> };
    };
    expect(payload.reason).toBe("bounds_exceeded:wall_clock");
    expect(payload.consumed?.pct_consumed).toBeCloseTo(1, 4);
    expect(chainCancel).toHaveBeenCalledTimes(1);
    expect(chainCancel).toHaveBeenCalledWith("h-hard-1");
    expect(inject).not.toHaveBeenCalled();
  } finally {
    harness.db.close();
  }
});

test("hard kill race: task already done records completed termination and does not cancel", () => {
  const harness = createTaskHarness(1_000);
  try {
    const taskId = fileOrchestrateTask(harness.taskWriter);
    const lease = harness.taskWriter.lease({ task_id: taskId, agent_id: MAESTRO_AGENT.name });
    seedSession(harness.db, {
      task_id: taskId,
      chain_handoff_id: "h-race-done",
      started_at: 0,
    });

    harness.taskWriter.complete({
      task_id: taskId,
      lease_id: lease.lease_id,
      result_summary: "done now",
    });

    const chainCancel = mock<ChainCancelFn>(() => Promise.resolve());
    const callbacks = createBoundsCallbacks({
      db: harness.db,
      taskWriter: harness.taskWriter,
      sessions: harness.sessions,
      injector: { inject: noopInject },
      bus: harness.bus,
      chainCancel,
      now: () => 12_000,
    });

    harness.setNowMs(12_000);
    const session = harness.sessions.get(taskId);
    expect(session).toBeTruthy();
    if (!session) throw new Error("session missing");
    callbacks.onHardKill(session, "wall_clock");

    const updatedSession = harness.sessions.get(taskId);
    expect(updatedSession?.termination_reason).toBe("completed");
    expect(updatedSession?.terminated_at).toBe(12_000);
    expect(harness.taskWriter.get(taskId).status).toBe("done");
    expect(chainCancel).toHaveBeenCalledTimes(0);
  } finally {
    harness.db.close();
  }
});

test("hard kill race: task already done_pending_review records completed termination and does not cancel", () => {
  const harness = createTaskHarness(1_000);
  try {
    const taskId = fileOrchestrateTask(harness.taskWriter, { requires_review: true });
    const lease = harness.taskWriter.lease({ task_id: taskId, agent_id: MAESTRO_AGENT.name });
    seedSession(harness.db, {
      task_id: taskId,
      chain_handoff_id: "h-race-review",
      started_at: 0,
    });

    harness.taskWriter.complete({
      task_id: taskId,
      lease_id: lease.lease_id,
      result_summary: "ready for review",
    });

    const chainCancel = mock<ChainCancelFn>(() => Promise.resolve());
    const callbacks = createBoundsCallbacks({
      db: harness.db,
      taskWriter: harness.taskWriter,
      sessions: harness.sessions,
      injector: { inject: noopInject },
      bus: harness.bus,
      chainCancel,
      now: () => 12_500,
    });

    harness.setNowMs(12_500);
    const session = harness.sessions.get(taskId);
    expect(session).toBeTruthy();
    if (!session) throw new Error("session missing");
    callbacks.onHardKill(session, "wall_clock");

    const updatedSession = harness.sessions.get(taskId);
    expect(updatedSession?.termination_reason).toBe("completed");
    expect(updatedSession?.terminated_at).toBe(12_500);
    expect(harness.taskWriter.get(taskId).status).toBe("done_pending_review");
    expect(chainCancel).toHaveBeenCalledTimes(0);
  } finally {
    harness.db.close();
  }
});

test("hard kill: chainCancel rejection is swallowed and logged", async () => {
  const harness = createTaskHarness(1_000);
  try {
    const taskId = fileOrchestrateTask(harness.taskWriter);
    harness.taskWriter.lease({ task_id: taskId, agent_id: MAESTRO_AGENT.name });
    seedSession(harness.db, {
      task_id: taskId,
      chain_handoff_id: "h-cancel-fail",
      started_at: 0,
    });

    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const chainCancel = mock<ChainCancelFn>(() => Promise.reject(new Error("cancel failed")));

    const callbacks = createBoundsCallbacks({
      db: harness.db,
      taskWriter: harness.taskWriter,
      sessions: harness.sessions,
      injector: { inject: noopInject },
      bus: harness.bus,
      chainCancel,
      now: () => 14_000,
    });

    const session = harness.sessions.get(taskId);
    expect(session).toBeTruthy();
    if (!session) throw new Error("session missing");

    expect(() => {
      callbacks.onHardKill(session, "wall_clock");
    }).not.toThrow();
    await Bun.sleep(0);

    expect(harness.taskWriter.get(taskId).status).toBe("failed");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("[bounds-callbacks] chain cancel failed");
  } finally {
    harness.db.close();
  }
});
