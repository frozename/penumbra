import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { MaestroSessionWriter } from "@src/maestro/writer.js";
import { TaskWriter } from "@src/tasks/writer.js";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

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

function seedTask(
  db: Database,
  params: {
    id: string;
    kind: "work" | "orchestrate";
    status?: "pending" | "leased" | "done_pending_review" | "done" | "failed" | "cancelled";
  },
): void {
  const now = 1_000;
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
    params.id,
    now,
    now,
    "human",
    "cli",
    null,
    params.kind,
    "normal",
    "coordinate the work",
    null,
    null,
    "{}",
    null,
    0,
    null,
    null,
    null,
    null,
    params.status ?? "pending",
    null,
    null,
    null,
    null,
    null,
  );
}

function seedOrchestrateTask(db: Database, task_id: string): void {
  seedTask(db, { id: task_id, kind: "orchestrate" });
}

describe("TaskWriter.cancel orchestrate sessions", () => {
  let db: Database;
  let sessions: MaestroSessionWriter;
  let taskWriter: TaskWriter;
  let callbackCalls: string[];

  beforeEach(() => {
    db = freshDb();
    sessions = new MaestroSessionWriter({ db, now: (): number => 2_000 });
    callbackCalls = [];
    taskWriter = new TaskWriter(db, {
      maestroSessions: sessions,
      onOrchestrateCancel: (chain_handoff_id: string): void => {
        callbackCalls.push(chain_handoff_id);
      },
    });
  });

  test("cancel orchestrate with active session terminates session and calls chain cancel", () => {
    const task_id = "task-orchestrate-active";
    seedOrchestrateTask(db, task_id);
    sessions.start({
      task_id,
      chain_handoff_id: "handoff-active",
      agent_id: "agent-a",
      wall_clock_budget_ms: 3_000,
      cost_budget_cents: 250,
      sub_dispatch_budget: 5,
    });

    const result = taskWriter.cancel({ task_id });
    expect(result.status).toBe("cancelled");
    expect(callbackCalls).toEqual(["handoff-active"]);

    const task = taskWriter.get(task_id);
    expect(task.status).toBe("cancelled");

    const session = sessions.get(task_id);
    expect(session).not.toBeNull();
    expect(session!.terminated_at).not.toBeNull();
    expect(session!.termination_reason).toBe("cancelled");

    const events = db
      .query<{ kind: string; payload_json: string | null }, [string]>(
        `SELECT kind, payload_json FROM task_events WHERE task_id = ? ORDER BY id ASC`,
      )
      .all(task_id)
      .map((row) => ({
        kind: row.kind,
        payload: row.payload_json ? (JSON.parse(row.payload_json) as unknown) : null,
      }));
    expect(events.map((event) => event.kind)).toEqual(["cancelled", "orchestrate_terminated"]);
    expect(events[1]!.payload).toEqual({ reason: "cancelled" });
  });

  test("cancel orchestrate with no session row does not terminate or callback", () => {
    const task_id = "task-orchestrate-missing";
    seedOrchestrateTask(db, task_id);

    const result = taskWriter.cancel({ task_id });
    expect(result.status).toBe("cancelled");
    expect(callbackCalls).toEqual([]);

    const session = sessions.get(task_id);
    expect(session).toBeNull();

    const kinds = db
      .query<{ kind: string }, [string]>(
        `SELECT kind FROM task_events WHERE task_id = ? ORDER BY id ASC`,
      )
      .all(task_id)
      .map((row) => row.kind);
    expect(kinds).toEqual(["cancelled"]);
  });

  test("cancel orchestrate with already-terminated session leaves session unchanged", () => {
    const task_id = "task-orchestrate-terminated";
    seedOrchestrateTask(db, task_id);
    sessions.start({
      task_id,
      chain_handoff_id: "handoff-terminated",
      agent_id: "agent-a",
      wall_clock_budget_ms: 3_000,
      cost_budget_cents: 250,
      sub_dispatch_budget: 5,
    });
    sessions.terminate(task_id, "completed");
    const before = sessions.get(task_id);

    const result = taskWriter.cancel({ task_id });
    expect(result.status).toBe("cancelled");
    expect(callbackCalls).toEqual([]);

    const after = sessions.get(task_id);
    expect(after).toEqual(before);

    const kinds = db
      .query<{ kind: string }, [string]>(
        `SELECT kind FROM task_events WHERE task_id = ? ORDER BY id ASC`,
      )
      .all(task_id)
      .map((row) => row.kind);
    expect(kinds).toEqual(["cancelled"]);
  });

  test("cancel non-orchestrate keeps existing behavior", () => {
    const task_id = "task-work";
    seedTask(db, { id: task_id, kind: "work" });

    const result = taskWriter.cancel({ task_id });
    expect(result.status).toBe("cancelled");
    expect(callbackCalls).toEqual([]);

    const session = sessions.get(task_id);
    expect(session).toBeNull();

    const kinds = db
      .query<{ kind: string }, [string]>(
        `SELECT kind FROM task_events WHERE task_id = ? ORDER BY id ASC`,
      )
      .all(task_id)
      .map((row) => row.kind);
    expect(kinds).toEqual(["cancelled"]);
  });

  test("chain cancel callback throws but cancel still succeeds", () => {
    const throwingWriter = new TaskWriter(db, {
      maestroSessions: sessions,
      onOrchestrateCancel: (): void => {
        throw new Error("boom");
      },
    });
    const warn = mock((): void => {
      /* swallow */
    });
    const originalWarn = console.warn;
    console.warn = warn;

    try {
      const task_id = "task-orchestrate-throwing";
      seedOrchestrateTask(db, task_id);
      sessions.start({
        task_id,
        chain_handoff_id: "handoff-throwing",
        agent_id: "agent-a",
        wall_clock_budget_ms: 3_000,
        cost_budget_cents: 250,
        sub_dispatch_budget: 5,
      });

      const result = throwingWriter.cancel({ task_id });
      expect(result.status).toBe("cancelled");
      expect(throwingWriter.get(task_id).status).toBe("cancelled");
      expect(sessions.get(task_id)!.termination_reason).toBe("cancelled");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = originalWarn;
    }
  });
});
