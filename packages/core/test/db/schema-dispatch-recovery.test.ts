import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema, SCHEMA_VERSION } from "../../src/db/schema.js";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // already loaded by a sibling test file — no-op
  }
}

describe("schema-dispatch-recovery", () => {
  it("adds dispatch recovery columns to handoffs table", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    const columns = db
      .query<
        { name: string; type: string; dflt_value: any; notnull: number },
        []
      >("PRAGMA table_info(handoffs)")
      .all();

    const dispatchAttempts = columns.find((c) => c.name === "dispatch_attempts");
    expect(dispatchAttempts).toBeDefined();
    expect(dispatchAttempts?.type).toBe("INTEGER");
    expect(dispatchAttempts?.notnull).toBe(1);
    expect(dispatchAttempts?.dflt_value).toBe("0");

    const maxDispatchAttempts = columns.find((c) => c.name === "max_dispatch_attempts");
    expect(maxDispatchAttempts).toBeDefined();
    expect(maxDispatchAttempts?.type).toBe("INTEGER");
    expect(maxDispatchAttempts?.notnull).toBe(1);
    expect(maxDispatchAttempts?.dflt_value).toBe("3");

    const lastDispatchStartedAt = columns.find((c) => c.name === "last_dispatch_started_at");
    expect(lastDispatchStartedAt).toBeDefined();
    expect(lastDispatchStartedAt?.type).toBe("TEXT");
    expect(lastDispatchStartedAt?.notnull).toBe(0);

    const workflowRunId = columns.find((c) => c.name === "workflow_run_id");
    expect(workflowRunId).toBeDefined();
    expect(workflowRunId?.type).toBe("TEXT");
    expect(workflowRunId?.notnull).toBe(0);

    const indexes = db.query<{ name: string }, []>("PRAGMA index_list(handoffs)").all();
    const hasIndex = indexes.some((idx) => idx.name === "handoffs_status_worker_ts");
    expect(hasIndex).toBe(true);
  });

  it("safely migrates a legacy database", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);

    // Seed with old schema
    db.exec(`
      CREATE TABLE handoffs (
        handoff_id              TEXT PRIMARY KEY,
        ts                      TEXT NOT NULL,
        project_id              TEXT,
        conversation_id         TEXT NOT NULL,
        from_agent              TEXT NOT NULL,
        to_agent                TEXT NOT NULL,
        to_role                 TEXT,
        message                 TEXT NOT NULL,
        status                  TEXT NOT NULL,
        resolved_by             TEXT,
        resolved_at             TEXT,
        redirected_to           TEXT,
        resolution_reason       TEXT,
        triggered_by_event_id   TEXT,
        chain_max_hops          INTEGER,
        chain_trust_mode        TEXT,
        chain_task_type         TEXT,
        dispatch_kind           TEXT,
        long_lived_agent_id     TEXT,
        long_lived_tick_id      TEXT,
        use_worktree            INTEGER,
        open_pr_on_review       INTEGER,
        branch_base             TEXT,
        error_message           TEXT,
        cancel_requested_at     TEXT,
        worker_id               TEXT
      );
    `);

    // Apply schema with new additions
    expect(() => applySchema(db)).not.toThrow();

    // Verify columns were added
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(handoffs)").all();

    expect(columns.some((c) => c.name === "dispatch_attempts")).toBe(true);
    expect(columns.some((c) => c.name === "max_dispatch_attempts")).toBe(true);
    expect(columns.some((c) => c.name === "last_dispatch_started_at")).toBe(true);
    expect(columns.some((c) => c.name === "workflow_run_id")).toBe(true);

    const indexes = db.query<{ name: string }, []>("PRAGMA index_list(handoffs)").all();
    const hasIndex = indexes.some((idx) => idx.name === "handoffs_status_worker_ts");
    expect(hasIndex).toBe(true);
  });
});
