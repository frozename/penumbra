import { loadSqliteVec, MaestroSessionWriter, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { createBoundsTracker } from "../../src/maestro/bounds-tracker.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: platform-specific sqlite setup
  }
}

function setupDb(): Database {
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
      string | null,
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

describe("bounds tracker long-lived kind", () => {
  let db: Database;
  let nowMs = 0;
  let sessions: MaestroSessionWriter;

  beforeEach(() => {
    db = setupDb();
    sessions = new MaestroSessionWriter({ db, now: (): number => nowMs });
  });

  test("soft warning and hard kill carry long_lived_tick kind", () => {
    seedTask(db, "task-1");
    sessions.start({
      task_id: "task-1",
      chain_handoff_id: "chain-1",
      agent_id: "agent-1",
      wall_clock_budget_ms: 1_000,
      cost_budget_cents: 100,
      sub_dispatch_budget: 10,
    });

    const softWarns: { task_id: string; kind: string }[] = [];
    const hardKills: { task_id: string; axis: string; kind: string }[] = [];
    const tracker = createBoundsTracker({
      db,
      sessions,
      kind: "long_lived_tick",
      now: (): number => nowMs,
      onSoftWarn: (session, kind): void => {
        softWarns.push({ task_id: session.task_id, kind });
      },
      onHardKill: (session, axis, kind): void => {
        hardKills.push({ task_id: session.task_id, axis, kind });
      },
    });

    nowMs = 800;
    tracker.tick();
    expect(softWarns).toHaveLength(1);
    expect(softWarns[0]?.task_id).toBe("task-1");
    expect(softWarns[0]?.kind).toBe("long_lived_tick");
    expect(hardKills).toHaveLength(0);

    nowMs = 1_000;
    tracker.tick();
    expect(hardKills).toHaveLength(1);
    expect(hardKills[0]?.task_id).toBe("task-1");
    expect(hardKills[0]?.kind).toBe("long_lived_tick");
  });
});
