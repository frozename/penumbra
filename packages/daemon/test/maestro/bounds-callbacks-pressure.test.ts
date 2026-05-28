import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { AgentDescriptor, CapCheckWarn } from "@penumbra/core";
import {
  loadSqliteVec,
  MaestroSessionWriter,
  migrate,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import { createBoundsCallbacks } from "../../src/maestro/bounds-callbacks.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

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

function createTaskHarness(nowMs = 1_000): {
  db: Database;
  bus: TaskEventBus;
  taskWriter: TaskWriter;
  sessions: MaestroSessionWriter;
  setNowMs: (value: number) => void;
} {
  const db = setupDb();
  const bus = new TaskEventBus();
  let currentNow = nowMs;
  const taskWriter = new TaskWriter(db, {
    now: () => currentNow,
    bus,
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
  });
  const sessions = new MaestroSessionWriter({ db, now: () => currentNow });

  return {
    db,
    bus,
    taskWriter,
    sessions,
    setNowMs: (value) => {
      currentNow = value;
    },
  };
}

function fileOrchestrateTask(taskWriter: TaskWriter): string {
  return taskWriter.file({
    prompt: "coordinate this task",
    kind: "orchestrate",
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
    100_000,
    200,
    10,
    0,
    0,
  );
}

afterEach(() => {
  mock.restore();
});

test("pressure soft warn injects a warning and records an orchestrate_warning event", async () => {
  const harness = createTaskHarness(1_000);
  try {
    const taskId = fileOrchestrateTask(harness.taskWriter);
    seedSession(harness.db, {
      task_id: taskId,
      chain_handoff_id: "h-pressure-1",
      started_at: 0,
    });

    const inject = mock(
      async (_chainHandoffId: string, _msg: { role: "user"; text: string }) => {},
    );
    const chainCancel = mock(async (_chainHandoffId: string) => {});
    const outcome: CapCheckWarn = {
      state: "warn",
      provider: "anthropic",
      window_label: "seven_day",
      used_pct: 73,
      warn_pct: 70,
      refuse_pct: 95,
      snapshot_age_seconds: 120,
      snapshot_state: "fresh",
    };

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
    callbacks.onPressureSoftWarn(session!, outcome);
    await Bun.sleep(0);

    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0]?.[0]).toBe("h-pressure-1");
    const message = inject.mock.calls[0]?.[1] as { role: "user"; text: string } | undefined;
    expect(message?.role).toBe("user");
    expect(message?.text).toContain("Subscription pressure on anthropic");
    expect(message?.text).toContain("73%");
    expect(message?.text).toContain("warn threshold 70%");
    expect(message?.text).toContain("refuse threshold 95%");

    const row = harness.db
      .query<
        { payload_json: string | null },
        [string]
      >(`SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_warning' ORDER BY id DESC LIMIT 1`)
      .get(taskId);
    expect(row).toBeTruthy();
    const payload = JSON.parse(row?.payload_json ?? "{}") as {
      axis?: string;
      provider?: string;
      window_label?: string;
      used_pct?: number;
      warn_pct?: number;
      refuse_pct?: number;
      soft_warned_at?: number;
    };
    expect(payload).toMatchObject({
      axis: "subscription_pressure",
      provider: "anthropic",
      window_label: "seven_day",
      used_pct: 73,
      warn_pct: 70,
      refuse_pct: 95,
      soft_warned_at: 8_500,
    });
    expect(chainCancel).toHaveBeenCalledTimes(0);
    expect(harness.taskWriter.get(taskId).status).toBe("pending");
  } finally {
    harness.db.close();
  }
});

test("pressure soft warn swallows injector errors and logs them", async () => {
  const harness = createTaskHarness(1_000);
  try {
    const taskId = fileOrchestrateTask(harness.taskWriter);
    seedSession(harness.db, {
      task_id: taskId,
      chain_handoff_id: "h-pressure-2",
      started_at: 0,
    });

    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const inject = mock(async () => {
      throw new Error("inject failed");
    });
    const outcome: CapCheckWarn = {
      state: "warn",
      provider: "anthropic",
      window_label: "seven_day",
      used_pct: 73,
      warn_pct: 70,
      refuse_pct: 95,
      snapshot_age_seconds: 120,
      snapshot_state: "fresh",
    };

    const callbacks = createBoundsCallbacks({
      db: harness.db,
      taskWriter: harness.taskWriter,
      sessions: harness.sessions,
      injector: { inject },
      bus: harness.bus,
      chainCancel: async () => {},
      now: () => 8_500,
    });

    const session = harness.sessions.get(taskId);
    expect(session).toBeTruthy();

    expect(() => callbacks.onPressureSoftWarn(session!, outcome)).not.toThrow();
    await Bun.sleep(0);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(
      "[bounds-callbacks] pressure soft warning failed",
    );
  } finally {
    harness.db.close();
  }
});
