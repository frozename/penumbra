import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { SCHEMA_VERSION } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks', 'task_leases', 'task_events') ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

function indexNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('tasks', 'task_leases', 'task_events') ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

test("migration applies cleanly to a v14 db", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);

  migrate(db, { embeddingDim: 384 });

  const version = db
    .query<{ value: string }, [string]>("SELECT value FROM db_meta WHERE key = ?")
    .get("schema_version");

  expect(version?.value).toBe(String(SCHEMA_VERSION));
  expect(tableNames(db)).toEqual(["task_events", "task_leases", "tasks"]);

  db.close();
});

test("migration is idempotent on a v14 db", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);

  migrate(db, { embeddingDim: 384 });
  const firstIndexes = indexNames(db);
  migrate(db, { embeddingDim: 384 });

  const version = db
    .query<{ value: string }, [string]>("SELECT value FROM db_meta WHERE key = ?")
    .get("schema_version");

  expect(version?.value).toBe(String(SCHEMA_VERSION));
  expect(tableNames(db)).toEqual(["task_events", "task_leases", "tasks"]);
  expect(indexNames(db)).toEqual(firstIndexes);
  expect(firstIndexes).toContain("task_events_task_id_at");
  expect(firstIndexes).toContain("task_leases_agent_id_released_at");
  expect(firstIndexes).toContain("task_leases_task_id_released_at");
  expect(firstIndexes).toContain("tasks_chain_id");
  expect(firstIndexes).toContain("tasks_created_by_id");
  expect(firstIndexes).toContain("tasks_parent_task_id");
  expect(firstIndexes).toContain("tasks_status_priority_created_at");

  db.close();
});

test("migration preserves existing rows in pre-existing tables", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);

  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id, user_id,
      machine_id, session_id, event_type, lane, provider, model, tokens_in,
      tokens_out, cost_usd, latency_ms, request_id, payload_json, payload_summary
    ) VALUES (
      'evt-1', '2026-05-05T00:00:00Z', '2026-05-05T00:00:01Z', 'claude',
      'hook', 'proj-1', 'user-1', 'machine-1', 'sess-1', 'message', 't0',
      'anthropic', 'claude-3', 10, 20, 0.25, 300, 'req-1',
      '{"text":"hello"}', 'hello summary'
    );
    INSERT INTO t1_rollups (
      rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events,
      lane_breakdown_json, provider_breakdown_json, cost_usd_total, tokens_in_total,
      tokens_out_total, first_prompt_excerpt, last_response_excerpt, tool_calls_summary,
      source_event_ids, t2_promoted_at, failed_promotion_attempts
    ) VALUES (
      'rollup-1', 'proj-1', 'user-1', 'sess-1', '2026-05-05T00:00:00Z',
      '2026-05-05T00:10:00Z', 1, '{}', '{}', 0.25, 10, 20, 'prompt', 'response',
      'tool calls', '["evt-1"]', NULL, 0
    );
    INSERT INTO handoffs (
      handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role,
      message, status, resolved_by, resolved_at, redirected_to, resolution_reason,
      triggered_by_event_id, chain_max_hops, chain_trust_mode, chain_task_type,
      use_worktree, error_message, cancel_requested_at, worker_id
    ) VALUES (
      'handoff-1', '2026-05-05T00:00:00Z', 'proj-1', 'conv-1', 'claude', 'codex',
      'reviewer', 'please help', 'pending', NULL, NULL, NULL, NULL, 'evt-1', 2,
      'trusted', 'task', 1, NULL, NULL, 'worker-1'
    );
  `);

  migrate(db, { embeddingDim: 384 });

  const t0 = db
    .query<
      {
        event_id: string;
        payload_json: string;
        payload_summary: string | null;
      },
      [string]
    >("SELECT event_id, payload_json, payload_summary FROM t0_events WHERE event_id = ?")
    .get("evt-1");
  expect(t0).toEqual({
    event_id: "evt-1",
    payload_json: '{"text":"hello"}',
    payload_summary: "hello summary",
  });

  const t1 = db
    .query<
      {
        rollup_id: string;
        source_event_ids: string;
        failed_promotion_attempts: number;
      },
      [string]
    >(
      "SELECT rollup_id, source_event_ids, failed_promotion_attempts FROM t1_rollups WHERE rollup_id = ?",
    )
    .get("rollup-1");
  expect(t1).toEqual({
    rollup_id: "rollup-1",
    source_event_ids: '["evt-1"]',
    failed_promotion_attempts: 0,
  });

  const handoff = db
    .query<
      {
        handoff_id: string;
        status: string;
        worker_id: string;
      },
      [string]
    >("SELECT handoff_id, status, worker_id FROM handoffs WHERE handoff_id = ?")
    .get("handoff-1");
  expect(handoff).toEqual({
    handoff_id: "handoff-1",
    status: "pending",
    worker_id: "worker-1",
  });

  db.close();
});

test("migration can recreate v9 tables after downgrading schema_version to 8", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);

  migrate(db, { embeddingDim: 384 });
  db.run(`
    DROP TABLE task_events;
    DROP TABLE task_leases;
    DROP TABLE tasks;
    UPDATE db_meta SET value = '8' WHERE key = 'schema_version';
  `);

  migrate(db, { embeddingDim: 384 });

  const version = db
    .query<{ value: string }, [string]>("SELECT value FROM db_meta WHERE key = ?")
    .get("schema_version");

  expect(version?.value).toBe(String(SCHEMA_VERSION));
  expect(tableNames(db)).toEqual(["task_events", "task_leases", "tasks"]);

  db.close();
});
