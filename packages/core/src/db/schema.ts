import { Database } from 'bun:sqlite';

export const SCHEMA_VERSION = 1;

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
        source_event_ids        TEXT NOT NULL DEFAULT '[]'
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
        error_message           TEXT,
        cancel_requested_at     TEXT
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
    `);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS t1_vec USING vec0(embedding FLOAT[${dim}])`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS t2_vec USING vec0(embedding FLOAT[${dim}])`);

    // Additive migration: columns added after the original handoffs table
    // landed. CREATE TABLE IF NOT EXISTS is a no-op on existing databases, so
    // these run as ALTER TABLE on every apply. SQLite raises "duplicate column"
    // when the column is already present; swallow that and continue.
    addHandoffColumnIfMissing(db, 'chain_max_hops', 'INTEGER');
    addHandoffColumnIfMissing(db, 'chain_trust_mode', 'TEXT');
    addHandoffColumnIfMissing(db, 'resolution_reason', 'TEXT');
    addHandoffColumnIfMissing(db, 'error_message', 'TEXT');
    addHandoffColumnIfMissing(db, 'cancel_requested_at', 'TEXT');

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function addHandoffColumnIfMissing(db: Database, name: string, type: string): void {
  const exists = db
    .query<{ count: number }, [string]>(`SELECT COUNT(*) as count FROM pragma_table_info('handoffs') WHERE name=?`)
    .get(name);
  if (exists && exists.count > 0) return;
  db.exec(`ALTER TABLE handoffs ADD COLUMN ${name} ${type}`);
}
