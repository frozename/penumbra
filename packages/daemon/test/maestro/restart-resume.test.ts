import type { AgentDescriptor, MaestroSessionRecord } from "@penumbra/core";

import {
  loadSqliteVec,
  MaestroSessionWriter,
  migrate,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import { runRestartResume } from "@src/maestro/restart-resume.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

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

interface Harness {
  db: Database;
  bus: TaskEventBus;
  sessions: MaestroSessionWriter;
  taskWriter: TaskWriter;
  setNow: (value: number) => void;
  close: () => void;
}

function createHarness(nowMs = 1_000): Harness {
  const db = setupDb();
  const bus = new TaskEventBus();
  let currentNow = nowMs;
  const sessions = new MaestroSessionWriter({ db, now: (): number => currentNow });
  const taskWriter = new TaskWriter(db, {
    now: (): number => currentNow,
    bus,
    resolveAgent: (name): AgentDescriptor | undefined =>
      name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined,
  });
  return {
    db,
    bus,
    sessions,
    taskWriter,
    setNow: (value: number): void => {
      currentNow = value;
    },
    close: (): void => {
      db.close();
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
    started_at?: number;
  },
): void {
  db.query<unknown, [string, string, string, number, number, number, number]>(
    `INSERT INTO maestro_sessions (
      task_id, chain_handoff_id, agent_id, started_at,
      wall_clock_budget_ms, cost_budget_cents, sub_dispatch_budget
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.task_id,
    input.chain_handoff_id,
    MAESTRO_AGENT.name,
    input.started_at ?? 0,
    100_000,
    200,
    10,
  );
}

function noopAttach(): void {
  // Tracker attach hook is asserted via call counts elsewhere.
}

test("no live sessions: returns zero counts", async () => {
  const harness = createHarness();
  try {
    const result = await runRestartResume({
      db: harness.db,
      sessions: harness.sessions,
      taskWriter: harness.taskWriter,
      isChainAlive: () => false,
      attachToTracker: noopAttach,
      bus: harness.bus,
      now: () => 1_234,
    });

    expect(result).toEqual({ resumed: 0, cleaned: 0 });
  } finally {
    harness.close();
  }
});

test("one dead chain and one live chain: dead is terminated and failed, live is reattached", async () => {
  const harness = createHarness();
  try {
    const deadTaskId = fileOrchestrateTask(harness.taskWriter);
    const liveTaskId = fileOrchestrateTask(harness.taskWriter);

    const deadLease = harness.taskWriter.lease({
      task_id: deadTaskId,
      agent_id: MAESTRO_AGENT.name,
    });
    harness.taskWriter.lease({ task_id: liveTaskId, agent_id: MAESTRO_AGENT.name });

    seedSession(harness.db, { task_id: deadTaskId, chain_handoff_id: "handoff-dead" });
    seedSession(harness.db, { task_id: liveTaskId, chain_handoff_id: "handoff-live" });
    harness.setNow(9_999);

    const attached: MaestroSessionRecord[] = [];
    const result = await runRestartResume({
      db: harness.db,
      sessions: harness.sessions,
      taskWriter: harness.taskWriter,
      isChainAlive: (handoffId) => handoffId === "handoff-live",
      attachToTracker: (session) => {
        attached.push(session);
      },
      bus: harness.bus,
      now: () => 9_999,
    });

    const deadSession = harness.sessions.get(deadTaskId);
    expect(deadSession?.terminated_at).toBe(9_999);
    expect(deadSession?.termination_reason).toBe("daemon_restart");

    const deadTask = harness.taskWriter.get(deadTaskId);
    expect(deadTask.status).toBe("failed");
    expect(deadTask.failure_reason).toBe("daemon_restart");

    const deadLeaseRow = harness.db
      .query<
        { released_at: number | null; release_reason: string | null },
        [string]
      >("SELECT released_at, release_reason FROM task_leases WHERE id = ?")
      .get(deadLease.lease_id);
    expect(deadLeaseRow?.released_at).toBe(9_999);
    expect(deadLeaseRow?.release_reason).toBe("failed");

    const deadTerminationEvent = harness.db
      .query<{ payload_json: string | null }, [string]>(
        `SELECT payload_json
         FROM task_events
         WHERE task_id = ? AND kind = 'orchestrate_terminated'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(deadTaskId);
    expect(deadTerminationEvent).toBeTruthy();
    expect(JSON.parse(deadTerminationEvent?.payload_json ?? "{}")).toEqual({
      reason: "daemon_restart",
    });

    const liveSession = harness.sessions.get(liveTaskId);
    expect(liveSession?.terminated_at).toBeNull();
    expect(liveSession?.termination_reason).toBeNull();

    expect(attached).toHaveLength(1);
    expect(attached[0]?.task_id).toBe(liveTaskId);
    expect(result).toEqual({ resumed: 1, cleaned: 1 });
  } finally {
    harness.close();
  }
});

test("all chains dead: terminates all without tracker attaches", async () => {
  const harness = createHarness();
  try {
    const taskIds = [
      fileOrchestrateTask(harness.taskWriter),
      fileOrchestrateTask(harness.taskWriter),
      fileOrchestrateTask(harness.taskWriter),
    ];
    for (const taskId of taskIds) {
      harness.taskWriter.lease({ task_id: taskId, agent_id: MAESTRO_AGENT.name });
      seedSession(harness.db, { task_id: taskId, chain_handoff_id: `handoff-${taskId}` });
    }
    harness.setNow(5_000);

    let attachCalls = 0;
    const result = await runRestartResume({
      db: harness.db,
      sessions: harness.sessions,
      taskWriter: harness.taskWriter,
      isChainAlive: () => false,
      attachToTracker: () => {
        attachCalls += 1;
      },
      bus: harness.bus,
      now: () => 5_000,
    });

    for (const taskId of taskIds) {
      const session = harness.sessions.get(taskId);
      expect(session?.terminated_at).toBe(5_000);
      expect(session?.termination_reason).toBe("daemon_restart");
    }
    expect(attachCalls).toBe(0);
    expect(result).toEqual({ resumed: 0, cleaned: 3 });
  } finally {
    harness.close();
  }
});

test("async liveness predicate is awaited", async () => {
  const harness = createHarness();
  try {
    const deadTaskId = fileOrchestrateTask(harness.taskWriter);
    const liveTaskId = fileOrchestrateTask(harness.taskWriter);
    harness.taskWriter.lease({ task_id: deadTaskId, agent_id: MAESTRO_AGENT.name });
    seedSession(harness.db, { task_id: deadTaskId, chain_handoff_id: "handoff-dead-async" });
    seedSession(harness.db, { task_id: liveTaskId, chain_handoff_id: "handoff-live-async" });

    const seen: string[] = [];
    const attached: string[] = [];
    const result = await runRestartResume({
      db: harness.db,
      sessions: harness.sessions,
      taskWriter: harness.taskWriter,
      isChainAlive: async (handoffId) => {
        seen.push(handoffId);
        await Bun.sleep(1);
        return handoffId === "handoff-live-async";
      },
      attachToTracker: (session) => {
        attached.push(session.task_id);
      },
      bus: harness.bus,
      now: () => 7_000,
    });

    expect(seen).toEqual(["handoff-dead-async", "handoff-live-async"]);
    expect(attached).toEqual([liveTaskId]);
    expect(harness.sessions.get(deadTaskId)?.termination_reason).toBe("daemon_restart");
    expect(harness.sessions.get(liveTaskId)?.terminated_at).toBeNull();
    expect(result).toEqual({ resumed: 1, cleaned: 1 });
  } finally {
    harness.close();
  }
});

test("dead chain with no open lease: marks task failed via best-effort update", async () => {
  const harness = createHarness();
  try {
    const taskId = fileOrchestrateTask(harness.taskWriter);
    seedSession(harness.db, { task_id: taskId, chain_handoff_id: "handoff-no-lease" });

    const result = await runRestartResume({
      db: harness.db,
      sessions: harness.sessions,
      taskWriter: harness.taskWriter,
      isChainAlive: () => false,
      attachToTracker: noopAttach,
      bus: harness.bus,
      now: () => 8_000,
    });

    const session = harness.sessions.get(taskId);
    expect(session?.termination_reason).toBe("daemon_restart");

    const task = harness.taskWriter.get(taskId);
    expect(task.status).toBe("failed");
    expect(task.failure_reason).toBe("daemon_restart");

    expect(result).toEqual({ resumed: 0, cleaned: 1 });
  } finally {
    harness.close();
  }
});

test("idempotent rerun: second run has nothing left to clean", async () => {
  const harness = createHarness();
  try {
    const taskId = fileOrchestrateTask(harness.taskWriter);
    harness.taskWriter.lease({ task_id: taskId, agent_id: MAESTRO_AGENT.name });
    seedSession(harness.db, { task_id: taskId, chain_handoff_id: "handoff-idempotent" });

    const first = await runRestartResume({
      db: harness.db,
      sessions: harness.sessions,
      taskWriter: harness.taskWriter,
      isChainAlive: () => false,
      attachToTracker: noopAttach,
      bus: harness.bus,
      now: () => 10_000,
    });
    const second = await runRestartResume({
      db: harness.db,
      sessions: harness.sessions,
      taskWriter: harness.taskWriter,
      isChainAlive: () => false,
      attachToTracker: noopAttach,
      bus: harness.bus,
      now: () => 11_000,
    });

    expect(first).toEqual({ resumed: 0, cleaned: 1 });
    expect(second).toEqual({ resumed: 0, cleaned: 0 });
  } finally {
    harness.close();
  }
});
