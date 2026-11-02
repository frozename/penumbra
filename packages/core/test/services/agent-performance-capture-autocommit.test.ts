import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import { loadSqliteVec, migrate } from "@src/index.js";
import {
  captureAgentPerformanceFromDispatch,
  captureAgentPerformanceFromReconciler,
} from "@src/services/agent-performance-capture.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: fall back to bundled SQLite if Homebrew lib is unavailable
  }
}

const AUTOCOMMIT_META = {
  status: "ok",
  worktree_changed: true,
  committed: true,
  dirty: false,
  autocommitted: true,
  autocommit_sha: "abc123",
};

describe("agent_performance autocommit metadata capture", () => {
  let db: Database;

  function insertDispatchEnd(meta: Record<string, unknown>): void {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run("h1", "worker-1", "dispatch.end", "2026-04-30T12:01:00Z", JSON.stringify(meta));
  }

  function persistedMetadata(): Record<string, unknown> {
    const row = db
      .query<
        { metadata_json: string },
        []
      >(`SELECT metadata_json FROM agent_performance WHERE handoff_id = 'h1'`)
      .get();
    return JSON.parse(row?.metadata_json ?? "{}") as Record<string, unknown>;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    db.prepare(
      `
      INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status, resolved_by, resolved_at, triggered_by_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "h1",
      "2026-04-30T12:00:00Z",
      "proj",
      "conv",
      "maestro",
      "claude",
      null,
      "Task type: implement_substantial\nImplement the plan",
      "completed",
      "worker",
      "2026-04-30T12:02:00Z",
      "event-1",
    );
    const insertUsage = db.prepare(`
      INSERT INTO t0_events (event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model, cost_usd, payload_json)
      VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'usage-update', 'cli-subscription', 'anthropic', 'claude', ?, ?)
    `);
    insertUsage.run(
      "u1",
      "2026-04-30T12:01:00Z",
      "2026-04-30T12:01:00Z",
      0.1,
      JSON.stringify({ handoff_id: "h1", used: 100 }),
    );
    insertUsage.run(
      "u2",
      "2026-04-30T12:01:30Z",
      "2026-04-30T12:01:30Z",
      0.25,
      JSON.stringify({ handoff_id: "h1", used: 250 }),
    );
  });

  it("records autocommitted and autocommit_sha from dispatch.end meta", () => {
    insertDispatchEnd(AUTOCOMMIT_META);

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-ac",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
    expect(meta.autocommitted).toBe(true);
    expect(meta.autocommit_sha).toBe("abc123");
    const persisted = persistedMetadata();
    expect(persisted.autocommitted).toBe(true);
    expect(persisted.autocommit_sha).toBe("abc123");
  });

  it("records autocommitted without an autocommit_sha key when no sha was reported", () => {
    insertDispatchEnd({
      status: "ok",
      worktree_changed: true,
      committed: true,
      dirty: false,
      autocommitted: true,
    });

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-ac-no-sha",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
    expect(meta.autocommitted).toBe(true);
    expect(meta).not.toHaveProperty("autocommit_sha");
  });

  it("omits autocommit flags when dispatch.end meta has no autocommitted flag", () => {
    insertDispatchEnd({ status: "ok", worktree_changed: true, committed: true, dirty: false });

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-no-ac",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
    expect(meta).not.toHaveProperty("autocommitted");
    expect(meta).not.toHaveProperty("autocommit_sha");
  });

  it("records autocommitted in reconciler capture metadata", () => {
    insertDispatchEnd(AUTOCOMMIT_META);

    const row = captureAgentPerformanceFromReconciler({
      db,
      uuid: () => "perf-ac-reconciler",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", result: { status: "merged" } },
    });

    const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
    expect(meta.autocommitted).toBe(true);
    expect(meta.autocommit_sha).toBe("abc123");
  });
});
