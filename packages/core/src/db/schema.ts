import { Database } from 'bun:sqlite';

export const SCHEMA_VERSION = 2;

export function applySchema(
  db: Database,
  opts: { embeddingDim?: number } = {},
): void {
  const dim = opts.embeddingDim ?? 384;
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS db_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        project_id        TEXT PRIMARY KEY,
        kind              TEXT NOT NULL,
        git_remote        TEXT,
        git_relpath_root  TEXT,
        marker_uuid       TEXT,
        display_name      TEXT,
        first_seen_paths  TEXT NOT NULL DEFAULT '[]',
        created_at        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS t0_events (
        event_id         TEXT PRIMARY KEY,
        ts               TEXT NOT NULL,
        ingest_ts        TEXT NOT NULL,
        source           TEXT NOT NULL,
        source_detail    TEXT,
        project_id       TEXT,
        user_id          TEXT NOT NULL,
        machine_id       TEXT NOT NULL,
        session_id       TEXT,
        event_type       TEXT NOT NULL,
        lane             TEXT NOT NULL,
        provider         TEXT,
        model            TEXT,
        tokens_in        INTEGER,
        tokens_out       INTEGER,
        cost_usd         REAL,
        latency_ms       INTEGER,
        request_id       TEXT,
        payload_json     TEXT NOT NULL,
        payload_summary  TEXT
      );
      CREATE INDEX IF NOT EXISTS t0_by_project_session ON t0_events(project_id, session_id, ts);
      CREATE INDEX IF NOT EXISTS t0_by_ingest_ts        ON t0_events(ingest_ts);

      CREATE TABLE IF NOT EXISTS t1_rollups (
        rollup_id               TEXT PRIMARY KEY,
        project_id              TEXT,
        user_id                 TEXT NOT NULL,
        session_id              TEXT NOT NULL,
        started_at              TEXT NOT NULL,
        ended_at                TEXT,
        n_events                INTEGER NOT NULL,
        lane_breakdown_json     TEXT NOT NULL DEFAULT '{}',
        provider_breakdown_json TEXT NOT NULL DEFAULT '{}',
        cost_usd_total          REAL,
        tokens_in_total         INTEGER,
        tokens_out_total        INTEGER,
        first_prompt_excerpt    TEXT,
        last_response_excerpt   TEXT,
        tool_calls_summary      TEXT,
        source_event_ids        TEXT NOT NULL DEFAULT '[]',
        t2_promoted_at          TEXT,
        failed_promotion_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS t1_by_project     ON t1_rollups(project_id, ended_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS t1_session ON t1_rollups(session_id);

      CREATE TABLE IF NOT EXISTS t2_memories (
        memory_id          TEXT PRIMARY KEY,
        project_id         TEXT,
        user_id            TEXT NOT NULL,
        kind               TEXT NOT NULL,
        source_session_ids TEXT NOT NULL DEFAULT '[]',
        window_start       TEXT NOT NULL,
        window_end         TEXT NOT NULL,
        title              TEXT NOT NULL,
        body               TEXT NOT NULL,
        metadata_json      TEXT NOT NULL DEFAULT '{}',
        compressed_from    TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS t2_by_project ON t2_memories(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS handoffs (
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
        use_worktree            INTEGER,
        error_message           TEXT,
        cancel_requested_at     TEXT,
        worker_id               TEXT
      );
      CREATE INDEX IF NOT EXISTS handoffs_pending ON handoffs(status, ts) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS handoffs_by_conv ON handoffs(conversation_id, ts);

      CREATE TABLE IF NOT EXISTS recall_audit (
        recall_id   TEXT PRIMARY KEY,
        ts          TEXT NOT NULL,
        project_id  TEXT,
        user_id     TEXT NOT NULL,
        query_text  TEXT,
        result_ids  TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS permission_requests (
        permission_id     TEXT PRIMARY KEY,
        parent_handoff_id TEXT NOT NULL,
        conversation_id   TEXT NOT NULL,
        agent_name        TEXT NOT NULL,
        tool_name         TEXT NOT NULL,
        raw_input_json    TEXT NOT NULL,
        status            TEXT NOT NULL,
        remember_scope    TEXT,
        decision_reason   TEXT,
        decided_by        TEXT,
        ttl_at            TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        decided_at        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_perm_status_conv ON permission_requests(status, conversation_id);
      CREATE INDEX IF NOT EXISTS idx_perm_parent      ON permission_requests(parent_handoff_id);
      CREATE INDEX IF NOT EXISTS idx_perm_ttl         ON permission_requests(status, ttl_at);

    `);

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS t0_fts USING fts5(
        content,
        event_id UNINDEXED
      );
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS t0_fts_insert AFTER INSERT ON t0_events BEGIN
        INSERT INTO t0_fts (rowid, content, event_id) VALUES (
          new.rowid,
          CASE
            WHEN json_valid(new.payload_json) THEN coalesce(
              json_extract(new.payload_json, '$.text'),
              json_extract(new.payload_json, '$.message'),
              json_extract(new.payload_json, '$.prompt'),
              json_extract(new.payload_json, '$.message_excerpt'),
              json_extract(new.payload_json, '$.response[0].text'),
              json_extract(new.payload_json, '$.response'),
              json_extract(new.payload_json, '$.input.text'),
              json_extract(new.payload_json, '$.input.message'),
              json_extract(new.payload_json, '$.input.prompt'),
              new.payload_summary,
              ''
            )
            ELSE coalesce(new.payload_summary, new.payload_json, '')
          END,
          new.event_id
        );
      END;
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS t0_fts_delete AFTER DELETE ON t0_events BEGIN
        DELETE FROM t0_fts WHERE rowid = old.rowid;
      END;
    `);

    db.exec(`
      INSERT INTO t0_fts (rowid, content, event_id)
        SELECT t.rowid,
               CASE
                 WHEN json_valid(t.payload_json) THEN coalesce(
                   json_extract(t.payload_json, '$.text'),
                   json_extract(t.payload_json, '$.message'),
                   json_extract(t.payload_json, '$.prompt'),
                   json_extract(t.payload_json, '$.message_excerpt'),
                   json_extract(t.payload_json, '$.response[0].text'),
                   json_extract(t.payload_json, '$.response'),
                   json_extract(t.payload_json, '$.input.text'),
                   json_extract(t.payload_json, '$.input.message'),
                   json_extract(t.payload_json, '$.input.prompt'),
                   t.payload_summary,
                   ''
                 )
                 ELSE coalesce(t.payload_summary, t.payload_json, '')
               END,
               t.event_id
          FROM t0_events t
         WHERE NOT EXISTS (SELECT 1 FROM t0_fts f WHERE f.rowid = t.rowid);
    `);

    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS t1_vec USING vec0(embedding FLOAT[${dim}])`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS t2_vec USING vec0(embedding FLOAT[${dim}])`);

    // Additive migration: columns added after the original handoffs table
    // landed. CREATE TABLE IF NOT EXISTS is a no-op on existing databases, so
    // these run as ALTER TABLE on every apply. SQLite raises "duplicate column"
    // when the column is already present; swallow that and continue.
    addColumnIfMissing(db, 'handoffs', 'chain_max_hops', 'INTEGER');
    addColumnIfMissing(db, 'handoffs', 'chain_trust_mode', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'use_worktree', 'INTEGER');
    addColumnIfMissing(db, 'handoffs', 'resolution_reason', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'error_message', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'cancel_requested_at', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'worker_id', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'parent_handoff_id', 'TEXT');

    // Additive migration for t1_rollups
    addColumnIfMissing(db, 't1_rollups', 't2_promoted_at', 'TEXT');
    addColumnIfMissing(db, 't1_rollups', 'failed_promotion_attempts', 'INTEGER NOT NULL DEFAULT 0');

    // Index for t2 promotion polling
    db.exec(`CREATE INDEX IF NOT EXISTS t1_unpromoted_idx ON t1_rollups(ended_at) WHERE t2_promoted_at IS NULL`);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function addColumnIfMissing(db: Database, table: string, name: string, type: string): void {
  const exists = db
    .query<{ count: number }, [string, string]>(`SELECT COUNT(*) as count FROM pragma_table_info(?) WHERE name=?`)
    .get(table, name);
  if (exists && exists.count > 0) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}
