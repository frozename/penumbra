import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { MaestroSessionExists, MaestroSessionWriter } from "@src/maestro/writer.js";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // already loaded
  }
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function seedTask(db: Database, taskId: string): void {
  db.query<
    unknown,
    [
      string,
      number,
      number,
      string,
      string,
      string | null,
      string,
      string,
      string,
      string | null,
      string | null,
      string,
      string | null,
      number,
      number | null,
      number | null,
      number | null,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ]
  >(
    `INSERT INTO tasks (
      id, created_at, updated_at, created_by_kind, created_by_id,
      parent_task_id, kind, priority, prompt, acceptance_criteria,
      expected_artifacts, eligibility, review_eligibility, requires_review,
      bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches,
      bounds_started_at, status, result_summary, result_artifacts,
      failure_reason, chain_id, origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    1,
    1,
    "workflow",
    "test-suite",
    null,
    "orchestrate",
    "normal",
    "coordinate the run",
    null,
    null,
    "{}",
    null,
    0,
    null,
    null,
    null,
    null,
    "pending",
    null,
    null,
    null,
    null,
    null,
  );
}

function startSession(
  writer: MaestroSessionWriter,
  task_id: string,
  chain_handoff_id: string,
  agent_id: string,
): void {
  writer.start({
    task_id,
    chain_handoff_id,
    agent_id,
    wall_clock_budget_ms: 3_000,
    cost_budget_cents: 250,
    sub_dispatch_budget: 5,
  });
}

describe("MaestroSessionWriter", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  test("start inserts a live row and uses fresh now() timestamps", () => {
    const nowValues = [1_000, 1_050];
    const writer = new MaestroSessionWriter({ db, now: (): number => nowValues.shift() ?? 0 });
    const taskA = "task-a";
    const taskB = "task-b";
    seedTask(db, taskA);
    seedTask(db, taskB);

    const first = writer.start({
      task_id: taskA,
      chain_handoff_id: "handoff-a",
      agent_id: "agent-a",
      wall_clock_budget_ms: 3_000,
      cost_budget_cents: 250,
      sub_dispatch_budget: 5,
    });
    const second = writer.start({
      task_id: taskB,
      chain_handoff_id: "handoff-b",
      agent_id: "agent-b",
      wall_clock_budget_ms: 4_000,
      cost_budget_cents: 300,
      sub_dispatch_budget: 7,
    });

    expect(first.started_at).toBe(1_000);
    expect(second.started_at).toBe(1_050);
    expect(first.started_at).not.toBe(second.started_at);

    const row = db
      .query<
        {
          task_id: string;
          chain_handoff_id: string;
          agent_id: string;
          started_at: number;
          wall_clock_budget_ms: number;
          cost_budget_cents: number;
          sub_dispatch_budget: number;
          cost_consumed_cents: number;
          sub_dispatches_consumed: number;
          soft_warned_at: number | null;
          terminated_at: number | null;
          termination_reason: string | null;
        },
        [string]
      >("SELECT * FROM maestro_sessions WHERE task_id = ?")
      .get(taskA);

    expect(row).toEqual({
      task_id: taskA,
      chain_handoff_id: "handoff-a",
      agent_id: "agent-a",
      started_at: 1_000,
      wall_clock_budget_ms: 3_000,
      cost_budget_cents: 250,
      sub_dispatch_budget: 5,
      cost_consumed_cents: 0,
      sub_dispatches_consumed: 0,
      soft_warned_at: null,
      terminated_at: null,
      termination_reason: null,
    });
  });

  test("start supports pre-bound rows with null chain_handoff_id", () => {
    const writer = new MaestroSessionWriter({ db, now: (): number => 1_000 });
    const taskId = "task-prebound-null-chain";
    seedTask(db, taskId);

    const session = writer.start({
      task_id: taskId,
      agent_id: "agent-a",
      wall_clock_budget_ms: 3_000,
      cost_budget_cents: 250,
      sub_dispatch_budget: 5,
    });

    expect(session.chain_handoff_id).toBeNull();
  });

  test("start rejects duplicate task_id with MaestroSessionExists", () => {
    const writer = new MaestroSessionWriter({ db, now: (): number => 1_000 });
    const taskId = "task-dup";
    seedTask(db, taskId);

    startSession(writer, taskId, "handoff-dup", "agent-a");

    expect(() => {
      startSession(writer, taskId, "handoff-dup-2", "agent-b");
    }).toThrow(MaestroSessionExists);
    try {
      startSession(writer, taskId, "handoff-dup-2", "agent-b");
    } catch (error) {
      expect(error).toBeInstanceOf(MaestroSessionExists);
      expect((error as MaestroSessionExists).task_id).toBe(taskId);
    }
  });

  test("start succeeds when a terminated session already exists for the same task_id", () => {
    const writer = new MaestroSessionWriter({ db, now: (): number => 2_000 });
    const taskId = "task-terminated-retry";
    seedTask(db, taskId);

    writer.start({
      task_id: taskId,
      chain_handoff_id: "handoff-first",
      agent_id: "agent-a",
      wall_clock_budget_ms: 3_000,
      cost_budget_cents: 250,
      sub_dispatch_budget: 5,
    });
    writer.terminate(taskId, "completed");

    let secondSession: ReturnType<typeof writer.start> | null = null;
    expect(() => {
      secondSession = writer.start({
        task_id: taskId,
        chain_handoff_id: "handoff-second",
        agent_id: "agent-b",
        wall_clock_budget_ms: 3_000,
        cost_budget_cents: 250,
        sub_dispatch_budget: 5,
      });
    }).not.toThrow();
    expect(secondSession).not.toBeNull();
    expect((secondSession as NonNullable<typeof secondSession>).chain_handoff_id).toBe(
      "handoff-second",
    );
    expect((secondSession as NonNullable<typeof secondSession>).agent_id).toBe("agent-b");
    const live = writer.get(taskId);
    expect(live?.chain_handoff_id).toBe("handoff-second");
    expect(live?.terminated_at).toBeNull();
  });

  test("get returns a hydrated row and null when missing", () => {
    const writer = new MaestroSessionWriter({ db, now: (): number => 1_000 });
    const taskId = "task-get";
    seedTask(db, taskId);
    startSession(writer, taskId, "handoff-get", "agent-a");

    expect(writer.get(taskId)).toEqual({
      task_id: taskId,
      chain_handoff_id: "handoff-get",
      agent_id: "agent-a",
      started_at: 1_000,
      wall_clock_budget_ms: 3_000,
      cost_budget_cents: 250,
      sub_dispatch_budget: 5,
      cost_consumed_cents: 0,
      sub_dispatches_consumed: 0,
      soft_warned_at: null,
      terminated_at: null,
      termination_reason: null,
    });
    expect(writer.get("missing-task")).toBeNull();
  });

  test("getByChainHandoff returns a hydrated row and null when missing", () => {
    const writer = new MaestroSessionWriter({ db, now: (): number => 1_000 });
    const taskId = "task-chain";
    seedTask(db, taskId);
    startSession(writer, taskId, "handoff-chain", "agent-a");

    expect(writer.getByChainHandoff("handoff-chain")).toEqual({
      task_id: taskId,
      chain_handoff_id: "handoff-chain",
      agent_id: "agent-a",
      started_at: 1_000,
      wall_clock_budget_ms: 3_000,
      cost_budget_cents: 250,
      sub_dispatch_budget: 5,
      cost_consumed_cents: 0,
      sub_dispatches_consumed: 0,
      soft_warned_at: null,
      terminated_at: null,
      termination_reason: null,
    });
    expect(writer.getByChainHandoff("missing-handoff")).toBeNull();
  });

  test("markDispatched sets chain_handoff_id once and rejects double-set", () => {
    const writer = new MaestroSessionWriter({ db, now: (): number => 1_000 });
    const taskId = "task-mark-dispatched";
    seedTask(db, taskId);
    writer.start({
      task_id: taskId,
      agent_id: "agent-a",
      wall_clock_budget_ms: 3_000,
      cost_budget_cents: 250,
      sub_dispatch_budget: 5,
    });

    const updated = writer.markDispatched(taskId, "handoff-marked");
    expect(updated.chain_handoff_id).toBe("handoff-marked");
    expect(writer.get(taskId)?.chain_handoff_id).toBe("handoff-marked");

    expect(() => writer.markDispatched(taskId, "handoff-marked-again")).toThrow(
      "already dispatched",
    );
  });

  test("listLive returns live rows ordered by started_at ascending", () => {
    const nowValues = [100, 200, 300];
    const writer = new MaestroSessionWriter({ db, now: (): number => nowValues.shift() ?? 0 });
    const tasks = ["task-live-1", "task-live-2", "task-live-3"];
    for (const taskId of tasks) seedTask(db, taskId);

    startSession(writer, tasks[0]!, "handoff-live-1", "agent-a");
    startSession(writer, tasks[1]!, "handoff-live-2", "agent-b");
    startSession(writer, tasks[2]!, "handoff-live-3", "agent-c");

    writer.terminate(tasks[1]!, "completed");

    expect(writer.listLive().map((row) => row.task_id)).toEqual([tasks[0], tasks[2]]);
  });

  test("incrementSubDispatch is atomic across concurrent calls", async () => {
    const writer = new MaestroSessionWriter({ db, now: (): number => 1_000 });
    const taskId = "task-subdispatch";
    seedTask(db, taskId);
    startSession(writer, taskId, "handoff-subdispatch", "agent-a");

    const settled = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        Promise.resolve().then(() => writer.incrementSubDispatch(taskId)),
      ),
    );
    const fulfilled = settled
      .filter(
        (result): result is PromiseFulfilledResult<{ new_count: number; budget: number }> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value);

    expect(fulfilled).toHaveLength(50);
    expect(Math.max(...fulfilled.map((value) => value.new_count))).toBe(50);
    expect(fulfilled.some((value) => value.new_count === 50)).toBe(true);

    const row = writer.get(taskId);
    expect(row?.sub_dispatches_consumed).toBe(50);
  });

  test("incrementSubDispatch returns zeroes for missing and terminated sessions", () => {
    const writer = new MaestroSessionWriter({ db, now: (): number => 1_000 });
    const taskId = "task-subdispatch-terminated";
    seedTask(db, taskId);
    startSession(writer, taskId, "handoff-subdispatch-term", "agent-a");
    writer.terminate(taskId, "cancelled");

    expect(writer.incrementSubDispatch("missing-task")).toEqual({ new_count: 0, budget: 0 });
    expect(writer.incrementSubDispatch(taskId)).toEqual({ new_count: 0, budget: 0 });
  });

  test("markSoftWarned only stamps the first time", () => {
    const nowValues = [1_000, 2_000, 3_000];
    const writer = new MaestroSessionWriter({ db, now: (): number => nowValues.shift() ?? 0 });
    const taskId = "task-soft-warning";
    seedTask(db, taskId);
    startSession(writer, taskId, "handoff-soft-warning", "agent-a");

    writer.markSoftWarned(taskId);
    expect(writer.get(taskId)?.soft_warned_at).toBe(2_000);

    writer.markSoftWarned(taskId);
    expect(writer.get(taskId)?.soft_warned_at).toBe(2_000);
  });

  test("terminate is idempotent and preserves the first reason and timestamp", () => {
    const nowValues = [1_000, 2_000, 3_000];
    const writer = new MaestroSessionWriter({ db, now: (): number => nowValues.shift() ?? 0 });
    const taskId = "task-terminate";
    seedTask(db, taskId);
    startSession(writer, taskId, "handoff-terminate", "agent-a");

    writer.terminate(taskId, "completed");
    writer.terminate(taskId, "failed");

    expect(writer.get(taskId)).toEqual({
      task_id: taskId,
      chain_handoff_id: "handoff-terminate",
      agent_id: "agent-a",
      started_at: 1_000,
      wall_clock_budget_ms: 3_000,
      cost_budget_cents: 250,
      sub_dispatch_budget: 5,
      cost_consumed_cents: 0,
      sub_dispatches_consumed: 0,
      soft_warned_at: null,
      terminated_at: 2_000,
      termination_reason: "completed",
    });
  });

  test("bumpCostConsumed writes the absolute value and ignores terminated sessions", () => {
    const writer = new MaestroSessionWriter({ db, now: (): number => 1_000 });
    const liveTaskId = "task-cost-live";
    const terminatedTaskId = "task-cost-terminated";
    seedTask(db, liveTaskId);
    seedTask(db, terminatedTaskId);
    startSession(writer, liveTaskId, "handoff-cost-live", "agent-a");
    startSession(writer, terminatedTaskId, "handoff-cost-term", "agent-b");
    writer.terminate(terminatedTaskId, "completed");

    writer.bumpCostConsumed(liveTaskId, 50);
    writer.bumpCostConsumed(liveTaskId, 30);
    writer.bumpCostConsumed(terminatedTaskId, 999);

    expect(writer.get(liveTaskId)?.cost_consumed_cents).toBe(30);
    expect(writer.get(terminatedTaskId)?.cost_consumed_cents).toBe(0);
  });
});
