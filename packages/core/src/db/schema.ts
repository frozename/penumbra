import { Database } from 'bun:sqlite';

export const SCHEMA_VERSION = 17;

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
      CREATE INDEX IF NOT EXISTS t0_events_task_draft_lookup
        ON t0_events(project_id, event_type, ts, event_id)
        WHERE event_type IN (
          'task_draft','task_draft_refining','task_draft_promoted',
          'task_draft_stale','task_draft_duplicate','task_draft_escalation'
        );
      CREATE INDEX IF NOT EXISTS t0_events_task_draft_id_lookup
        ON t0_events(json_extract(payload_json, '$.draft_id'), event_type, project_id, ts)
        WHERE event_type IN (
          'task_draft','task_draft_refining','task_draft_promoted',
          'task_draft_stale','task_draft_duplicate','task_draft_escalation'
        );

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

      CREATE TABLE IF NOT EXISTS t2_memory_verification_events (
        event_id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        verifier_actor TEXT NOT NULL,
        claimed_by TEXT,
        reason TEXT,
        session_id TEXT,
        verified_at TEXT NOT NULL,
        basis TEXT,
        basis_type TEXT,
        basis_detail TEXT,
        FOREIGN KEY (memory_id) REFERENCES t2_memories(memory_id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS t2_memory_verification_events_unique_memory_session
        ON t2_memory_verification_events(memory_id, session_id);
      CREATE INDEX IF NOT EXISTS t2_verification_events_by_memory
        ON t2_memory_verification_events(memory_id, verified_at DESC);

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
      CREATE INDEX IF NOT EXISTS handoffs_pending ON handoffs(status, ts) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS handoffs_by_conv ON handoffs(conversation_id, ts);

      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        result_json TEXT,
        error_json TEXT,
        result_spill_path TEXT,
        error_spill_path TEXT,
        expires_at INTEGER
      );
      -- workflow_runs indexes created in the additive migration block below,
      -- after addColumnIfMissing ensures expires_at exists on legacy DBs.

      CREATE TABLE IF NOT EXISTS tasks (
        id                    TEXT PRIMARY KEY,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        created_by_kind       TEXT NOT NULL,
        created_by_id         TEXT NOT NULL,
        project_id            TEXT,
        parent_task_id        TEXT,
        kind                  TEXT NOT NULL,
        priority              TEXT NOT NULL,
        prompt                TEXT NOT NULL,
        acceptance_criteria   TEXT,
        expected_artifacts    TEXT,
        eligibility           TEXT NOT NULL,
        review_eligibility    TEXT,
        requires_review       INTEGER NOT NULL,
        bounds_wall_clock_ms  INTEGER,
        bounds_cost_cents     INTEGER,
        bounds_max_sub_dispatches INTEGER,
        bounds_started_at     INTEGER,
        branch_base           TEXT,
        status                TEXT NOT NULL,
        result_summary        TEXT,
        result_artifacts      TEXT,
        failure_reason        TEXT,
        chain_id              TEXT,
        origin                TEXT,
        gh_issue_number       INTEGER,
        gh_issue_repo         TEXT,
        gh_last_comment_id    TEXT,
        gh_comments_synced_at INTEGER,
        gh_create_status      TEXT,
        gh_create_error       TEXT
      );
      CREATE INDEX IF NOT EXISTS tasks_status_priority_created_at ON tasks(status, priority, created_at);
      CREATE INDEX IF NOT EXISTS tasks_parent_task_id ON tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS tasks_created_by_id ON tasks(created_by_id);
      CREATE INDEX IF NOT EXISTS tasks_chain_id ON tasks(chain_id);
      -- tasks_by_gh index created in the additive migration block below, after
      -- addColumnIfMissing ensures gh_issue_* columns exist on legacy DBs.

      CREATE TABLE IF NOT EXISTS task_leases (
        id               TEXT PRIMARY KEY,
        task_id          TEXT NOT NULL,
        agent_id         TEXT NOT NULL,
        claimed_at       INTEGER NOT NULL,
        expires_at       INTEGER NOT NULL,
        released_at      INTEGER,
        release_reason   TEXT,
        auction_score    REAL,
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS task_leases_task_id_released_at ON task_leases(task_id, released_at);
      CREATE INDEX IF NOT EXISTS task_leases_agent_id_released_at ON task_leases(agent_id, released_at);

      CREATE TABLE IF NOT EXISTS task_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id         TEXT NOT NULL,
        maestro_session_task_id TEXT,
        at              INTEGER NOT NULL,
        kind            TEXT NOT NULL,
        actor           TEXT,
        payload_json    TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS task_events_task_id_at ON task_events(task_id, at);

      CREATE TABLE IF NOT EXISTS gh_outbox (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id       TEXT NOT NULL,
        op            TEXT NOT NULL,
        payload_json  TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        created_at    INTEGER NOT NULL,
        attempted_at  INTEGER,
        completed_at  INTEGER,
        error         TEXT
      );
      CREATE INDEX IF NOT EXISTS gh_outbox_status_created_at ON gh_outbox(status, created_at);
      CREATE INDEX IF NOT EXISTS gh_outbox_task_id_status ON gh_outbox(task_id, status);

      CREATE TABLE IF NOT EXISTS maestro_sessions (
        task_id TEXT PRIMARY KEY,
        chain_handoff_id TEXT,
        agent_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        wall_clock_budget_ms INTEGER NOT NULL,
        cost_budget_cents INTEGER NOT NULL,
        sub_dispatch_budget INTEGER NOT NULL,
        cost_consumed_cents INTEGER NOT NULL DEFAULT 0,
        sub_dispatches_consumed INTEGER NOT NULL DEFAULT 0,
        soft_warned_at INTEGER,
        terminated_at INTEGER,
        termination_reason TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS maestro_sessions_chain_handoff_id ON maestro_sessions(chain_handoff_id);
      CREATE INDEX IF NOT EXISTS maestro_sessions_terminated_at ON maestro_sessions(terminated_at);

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

      CREATE TABLE IF NOT EXISTS agent_performance (
        performance_id       TEXT PRIMARY KEY,
        ts                   TEXT NOT NULL,
        handoff_id           TEXT NOT NULL UNIQUE,
        conversation_id      TEXT,
        project_id           TEXT,
        agent_name           TEXT NOT NULL,
        task_type            TEXT NOT NULL,
        outcome              TEXT NOT NULL,
        gate_outcome         TEXT,
        rounds               INTEGER,
        smoke_pass           TEXT,
        reviewer_findings    INTEGER,
        maestro_score        INTEGER,
        cost_usd             REAL,
        tokens_used          INTEGER,
        latency_ms           INTEGER,
        source               TEXT NOT NULL,
        notes                TEXT,
        reliability_status   TEXT,
        failure_class        TEXT,
        artifact_present     TEXT,
        verification_present TEXT,
        maestro_takeover_required TEXT,
        empty_response       TEXT,
        worktree_changed     TEXT,
        reconcile_status     TEXT,
        environment_failure  TEXT,
        trust_score          REAL,
        agent_kind           TEXT,
        metadata_json        TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS agent_perf_by_task_agent
        ON agent_performance(task_type, agent_name, ts DESC);
      CREATE INDEX IF NOT EXISTS agent_perf_by_ts
        ON agent_performance(ts DESC);

      CREATE TABLE IF NOT EXISTS lane_ledger (
        lane_id              TEXT PRIMARY KEY,
        ts_opened            TEXT NOT NULL,
        ts_closed            TEXT,
        task_class           TEXT NOT NULL,
        implementer_handoff  TEXT NOT NULL,
        reviewer_handoff     TEXT,
        gate_status          TEXT NOT NULL,
        recalled_memory_ids  TEXT NOT NULL DEFAULT '[]',
        recalled_query       TEXT,
        override_reason      TEXT,
        metadata_json        TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS lane_ledger_by_status_ts ON lane_ledger(gate_status, ts_opened DESC);
      CREATE INDEX IF NOT EXISTS lane_ledger_by_task_class ON lane_ledger(task_class, ts_opened DESC);

      CREATE TABLE IF NOT EXISTS dispatch_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        handoff_id   TEXT NOT NULL,
        worker_id    TEXT,
        source       TEXT NOT NULL,
        kind         TEXT NOT NULL,
        ts           TEXT NOT NULL,
        meta_json    TEXT,
        CHECK (meta_json IS NULL OR length(meta_json) <= 4096)
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_events_handoff ON dispatch_events(handoff_id, ts);
      CREATE INDEX IF NOT EXISTS idx_dispatch_events_ts      ON dispatch_events(ts);

    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        plan_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        home_project TEXT NOT NULL,
        registered_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled'))
      );

      CREATE TABLE IF NOT EXISTS plan_tasks (
        plan_id TEXT NOT NULL REFERENCES plans(plan_id),
        task_meta_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        task_id_in_board TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled')),
        last_event_ts INTEGER,
        PRIMARY KEY (plan_id, task_meta_id)
      );

      CREATE INDEX IF NOT EXISTS plan_tasks_status ON plan_tasks(plan_id, status);
      CREATE INDEX IF NOT EXISTS plan_tasks_task_id_in_board ON plan_tasks(task_id_in_board);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS claude_code_sessions (
        session_id        TEXT PRIMARY KEY,
        session_start_at  TEXT NOT NULL,
        last_seen_at      TEXT NOT NULL,
        project_id        TEXT
      );
      CREATE INDEX IF NOT EXISTS claude_code_sessions_by_last_seen
        ON claude_code_sessions(last_seen_at DESC);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_stats (
        workflow_name          TEXT PRIMARY KEY,
        samples                INTEGER NOT NULL DEFAULT 0,
        successes              INTEGER NOT NULL DEFAULT 0,
        failures               INTEGER NOT NULL DEFAULT 0,
        avg_latency_ms         INTEGER NOT NULL DEFAULT 0,
        last_run_at            TEXT,
        last_failure_at        TEXT,
        last_failure_reason    TEXT,
        consecutive_failures   INTEGER NOT NULL DEFAULT 0,
        quarantined            INTEGER NOT NULL DEFAULT 0,
        quarantine_reason      TEXT,
        refresh_runs           INTEGER NOT NULL DEFAULT 0,
        intentional_runs       INTEGER NOT NULL DEFAULT 0
      );
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

    db.exec(`
      CREATE TABLE IF NOT EXISTS t0_file_refs (
        event_id   TEXT NOT NULL,
        file_path  TEXT NOT NULL,
        PRIMARY KEY (event_id, file_path),
        FOREIGN KEY (event_id) REFERENCES t0_events(event_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_t0_file_refs_path  ON t0_file_refs(file_path);
      CREATE INDEX IF NOT EXISTS idx_t0_file_refs_event ON t0_file_refs(event_id);

      -- Trigger extracts file_path from common claude-code/codex/opencode tool payload shapes.
      -- Single-file shape: { tool_input: { file_path: "..." } }
      -- We deliberately keep this narrow; multi-file extraction comes via the writer path
      -- when it has explicit knowledge of the schema.
      CREATE TRIGGER IF NOT EXISTS t0_file_refs_insert AFTER INSERT ON t0_events
      WHEN json_extract(new.payload_json, '$.tool_input.file_path') IS NOT NULL
      BEGIN
        INSERT OR IGNORE INTO t0_file_refs(event_id, file_path)
        VALUES (new.event_id, json_extract(new.payload_json, '$.tool_input.file_path'));
      END;
    `);

    // t1_fts — keyword index over per-session prompt + summary excerpts so
    // "what was I asking about ACP" becomes a deterministic query.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS t1_fts USING fts5(
        first_prompt_excerpt,
        last_response_excerpt,
        tool_calls_summary,
        content='t1_rollups',
        content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS t1_fts_insert AFTER INSERT ON t1_rollups BEGIN
        INSERT INTO t1_fts (rowid, first_prompt_excerpt, last_response_excerpt, tool_calls_summary)
        VALUES (new.rowid, new.first_prompt_excerpt, new.last_response_excerpt, new.tool_calls_summary);
      END;
      CREATE TRIGGER IF NOT EXISTS t1_fts_delete AFTER DELETE ON t1_rollups BEGIN
        INSERT INTO t1_fts (t1_fts, rowid, first_prompt_excerpt, last_response_excerpt, tool_calls_summary)
        VALUES ('delete', old.rowid, old.first_prompt_excerpt, old.last_response_excerpt, old.tool_calls_summary);
      END;
      CREATE TRIGGER IF NOT EXISTS t1_fts_update AFTER UPDATE ON t1_rollups BEGIN
        INSERT INTO t1_fts (t1_fts, rowid, first_prompt_excerpt, last_response_excerpt, tool_calls_summary)
        VALUES ('delete', old.rowid, old.first_prompt_excerpt, old.last_response_excerpt, old.tool_calls_summary);
        INSERT INTO t1_fts (rowid, first_prompt_excerpt, last_response_excerpt, tool_calls_summary)
        VALUES (new.rowid, new.first_prompt_excerpt, new.last_response_excerpt, new.tool_calls_summary);
      END;
    `);
    const taskColumns = db
      .query<{ name: string }, []>('PRAGMA table_info(tasks)')
      .all();
    if (!taskColumns.some((column) => column.name === 'project_id')) {
      db.exec('ALTER TABLE tasks ADD COLUMN project_id TEXT');
    }

    // t2_fts — multi-field FTS over the title/body and the new typed metadata.
    // Query like FTS5: t2_fts MATCH 'title:codex OR concepts:acp'
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS t2_fts USING fts5(
        title,
        body,
        obs_type,
        concepts,
        file_paths,
        content='t2_memories',
        content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS t2_fts_insert AFTER INSERT ON t2_memories BEGIN
        INSERT INTO t2_fts (rowid, title, body, obs_type, concepts, file_paths)
        VALUES (new.rowid, new.title, new.body, new.obs_type, new.concepts, new.file_paths);
      END;
      CREATE TRIGGER IF NOT EXISTS t2_fts_delete AFTER DELETE ON t2_memories BEGIN
        INSERT INTO t2_fts (t2_fts, rowid, title, body, obs_type, concepts, file_paths)
        VALUES ('delete', old.rowid, old.title, old.body, old.obs_type, old.concepts, old.file_paths);
      END;
      CREATE TRIGGER IF NOT EXISTS t2_fts_update AFTER UPDATE ON t2_memories BEGIN
        INSERT INTO t2_fts (t2_fts, rowid, title, body, obs_type, concepts, file_paths)
        VALUES ('delete', old.rowid, old.title, old.body, old.obs_type, old.concepts, old.file_paths);
        INSERT INTO t2_fts (rowid, title, body, obs_type, concepts, file_paths)
        VALUES (new.rowid, new.title, new.body, new.obs_type, new.concepts, new.file_paths);
      END;
    `);

    // Backfill the contentless FTS5 indexes for rows that existed before the
    // virtual tables were created. On a fresh DB both tables are empty so the
    // rebuild is a no-op; on an upgraded DB it indexes existing rows so the
    // delete-marker triggers in t1_fts/t2_fts have something to delete.
    db.exec(`
      INSERT INTO t1_fts(t1_fts) VALUES('rebuild');
      INSERT INTO t2_fts(t2_fts) VALUES('rebuild');
    `);

    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS t1_vec USING vec0(embedding FLOAT[${dim}])`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS t2_vec USING vec0(embedding FLOAT[${dim}])`);

    // Additive migration: columns added after the original handoffs table
    // landed. CREATE TABLE IF NOT EXISTS is a no-op on existing databases, so
    // these run as ALTER TABLE on every apply. SQLite raises "duplicate column"
    // when the column is already present; swallow that and continue.
    addColumnIfMissing(db, 'handoffs', 'chain_max_hops', 'INTEGER');
    addColumnIfMissing(db, 'handoffs', 'chain_trust_mode', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'chain_task_type', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'dispatch_kind', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'long_lived_agent_id', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'long_lived_tick_id', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'use_worktree', 'INTEGER');
    addColumnIfMissing(db, 'handoffs', 'open_pr_on_review', 'INTEGER');
    addColumnIfMissing(db, 'handoffs', 'branch_base', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'resolution_reason', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'error_message', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'cancel_requested_at', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'worker_id', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'parent_handoff_id', 'TEXT');
    addColumnIfMissing(db, 'handoffs', 'root_handoff_id', 'TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_handoffs_root_status ON handoffs(status, root_handoff_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS handoffs_root_by_conv ON handoffs(conversation_id, ts) WHERE parent_handoff_id IS NULL;`);
    backfillHandoffRoots(db);

    addColumnIfMissing(db, 'tasks', 'branch_base', 'TEXT');
    addColumnIfMissing(db, 'tasks', 'gh_issue_number', 'INTEGER');
    addColumnIfMissing(db, 'tasks', 'gh_issue_repo', 'TEXT');
    addColumnIfMissing(db, 'tasks', 'gh_last_comment_id', 'TEXT');
    addColumnIfMissing(db, 'tasks', 'gh_comments_synced_at', 'INTEGER');
    addColumnIfMissing(db, 'tasks', 'gh_create_status', 'TEXT');
    addColumnIfMissing(db, 'tasks', 'gh_create_error', 'TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS tasks_by_gh ON tasks(gh_issue_repo, gh_issue_number) WHERE gh_issue_number IS NOT NULL;`);

    // Additive migration for agent reliability evidence captured after the
    // original performance ledger shipped.
    addColumnIfMissing(db, 'agent_performance', 'reliability_status', 'TEXT');
    addColumnIfMissing(db, 'agent_performance', 'failure_class', 'TEXT');
    addColumnIfMissing(db, 'agent_performance', 'artifact_present', 'TEXT');
    addColumnIfMissing(db, 'agent_performance', 'verification_present', 'TEXT');
    addColumnIfMissing(db, 'agent_performance', 'maestro_takeover_required', 'TEXT');
    addColumnIfMissing(db, 'agent_performance', 'empty_response', 'TEXT');
    addColumnIfMissing(db, 'agent_performance', 'worktree_changed', 'TEXT');
    addColumnIfMissing(db, 'agent_performance', 'reconcile_status', 'TEXT');
    addColumnIfMissing(db, 'agent_performance', 'environment_failure', 'TEXT');
    addColumnIfMissing(db, 'agent_performance', 'trust_score', 'REAL');
    addColumnIfMissing(db, 'agent_performance', 'agent_kind', 'TEXT');
    addColumnIfMissing(db, 'agent_performance', 'gate_outcome', 'TEXT');

    addColumnIfMissing(db, 'workflow_stats', 'refresh_runs', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'workflow_stats', 'intentional_runs', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'workflow_runs', 'result_spill_path', 'TEXT');
    addColumnIfMissing(db, 'workflow_runs', 'error_spill_path', 'TEXT');
    addColumnIfMissing(db, 'workflow_runs', 'expires_at', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`CREATE INDEX IF NOT EXISTS workflow_runs_project_id ON workflow_runs(project_id, status, started_at DESC);`);
    db.exec(`CREATE INDEX IF NOT EXISTS workflow_runs_expires_at ON workflow_runs(expires_at);`);
    ensureNullableMaestroSessionChainHandoffId(db);

    // Origin tagging — categorical session lineage so recall can filter
    // out dispatched-agent transcripts without brittle deny-list patterns.
    // Values: 'maestro' | 'dispatch' | 'unknown' | NULL (legacy rows treated as unknown).
    addColumnIfMissing(db, 't0_events', 'origin', 'TEXT');
    addColumnIfMissing(db, 't1_rollups', 'origin', 'TEXT');
    addColumnIfMissing(db, 't2_memories', 'origin', 'TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_t2_origin ON t2_memories(origin) WHERE origin IS NOT NULL`);

    // Additive migration for t1_rollups
    addColumnIfMissing(db, 't1_rollups', 't2_promoted_at', 'TEXT');
    addColumnIfMissing(db, 't1_rollups', 'failed_promotion_attempts', 'INTEGER NOT NULL DEFAULT 0');

    // Index for t2 promotion polling
    db.exec(`CREATE INDEX IF NOT EXISTS t1_unpromoted_idx ON t1_rollups(ended_at) WHERE t2_promoted_at IS NULL`);

    // Additive migration for t2_memories — promote opaque metadata to first-class
    // columns so recall can filter without parsing JSON.
    addColumnIfMissing(db, 't2_memories', 'obs_type', 'TEXT');
    addColumnIfMissing(db, 't2_memories', 'concepts', 'TEXT'); // JSON array, FTS-indexed below
    addColumnIfMissing(db, 't2_memories', 'severity', 'TEXT'); // 'info' | 'warn' | 'error' | NULL
    addColumnIfMissing(db, 't2_memories', 'file_paths', 'TEXT'); // JSON array of repo-relative paths
    addColumnIfMissing(db, 't2_memories', 'last_verified_at', 'TEXT');
    addColumnIfMissing(db, 't2_memories', 'last_verified_by', 'TEXT');
    addColumnIfMissing(db, 't2_memories', 'last_verified_actor', 'TEXT');
    addColumnIfMissing(db, 't2_memories', 'last_verified_reason', 'TEXT');
    addColumnIfMissing(db, 't2_memories', 'last_verified_session_id', 'TEXT');
    addColumnIfMissing(db, 't2_memory_verification_events', 'basis', 'TEXT');
    addColumnIfMissing(db, 't2_memory_verification_events', 'basis_type', 'TEXT');
    addColumnIfMissing(db, 't2_memory_verification_events', 'basis_detail', 'TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_t2_obs_type ON t2_memories(obs_type) WHERE obs_type IS NOT NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_t2_severity ON t2_memories(severity) WHERE severity IS NOT NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS t2_memory_verification_events_basis_type
      ON t2_memory_verification_events(basis_type)
      WHERE basis_type IS NOT NULL`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS corpora (
        corpus_id    TEXT PRIMARY KEY,
        name         TEXT NOT NULL UNIQUE,
        description  TEXT,
        filter_json  TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        member_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS corpus_members (
        corpus_id  TEXT NOT NULL,
        memory_id  TEXT NOT NULL,
        added_at   TEXT NOT NULL,
        PRIMARY KEY (corpus_id, memory_id),
        FOREIGN KEY (corpus_id) REFERENCES corpora(corpus_id)     ON DELETE CASCADE,
        FOREIGN KEY (memory_id) REFERENCES t2_memories(memory_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_corpus_members_memory ON corpus_members(memory_id);

      CREATE TABLE IF NOT EXISTS long_lived_agents (
        id                           TEXT PRIMARY KEY,
        display_name                 TEXT NOT NULL,
        project_id                   TEXT,
        status                       TEXT NOT NULL DEFAULT 'active',
        degraded_reason              TEXT,
        consecutive_failures         INTEGER NOT NULL DEFAULT 0,
        circuit_breaker_threshold    INTEGER NOT NULL DEFAULT 3,
        schedule_cron                TEXT,
        subscriptions_json           TEXT,
        mcp_allowlist_json           TEXT NOT NULL DEFAULT '[]',
        snapshot_tool                TEXT,
        require_snapshot             INTEGER NOT NULL DEFAULT 0,
        approval_required_globs_json TEXT NOT NULL DEFAULT '[]',
        cooldown_overrides_json      TEXT NOT NULL DEFAULT '{}',
        bounds_wall_clock_ms         INTEGER,
        bounds_cost_cents            INTEGER,
        bounds_max_sub_dispatches    INTEGER,
        working_memory_json          TEXT NOT NULL,
        standing_brief               TEXT NOT NULL,
        last_tick_started_at         INTEGER,
        last_tick_completed_at       INTEGER,
        last_tick_outcome            TEXT,
        last_intent_summary          TEXT,
        created_at                   INTEGER NOT NULL,
        updated_at                   INTEGER NOT NULL,
        retired_at                   INTEGER
      );

      CREATE TABLE IF NOT EXISTS long_lived_ticks (
        id                       TEXT PRIMARY KEY,
        agent_id                 TEXT NOT NULL REFERENCES long_lived_agents(id),
        chain_id                 TEXT,
        trigger_kind             TEXT NOT NULL,
        trigger_payload_json     TEXT,
        intent_summary           TEXT,
        started_at               INTEGER NOT NULL,
        completed_at             INTEGER,
        outcome                  TEXT,
        cost_cents               INTEGER,
        error_summary            TEXT,
        working_memory_diff_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_long_lived_ticks_by_agent
        ON long_lived_ticks(agent_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS long_lived_pending_actions (
        id                  TEXT PRIMARY KEY,
        agent_id            TEXT NOT NULL REFERENCES long_lived_agents(id),
        tick_id             TEXT NOT NULL REFERENCES long_lived_ticks(id),
        action_kind         TEXT NOT NULL,
        action_target       TEXT NOT NULL,
        payload_json        TEXT NOT NULL,
        rationale           TEXT,
        status              TEXT NOT NULL DEFAULT 'pending',
        expires_at          INTEGER NOT NULL,
        decided_by          TEXT,
        decided_at          INTEGER,
        executed_in_tick_id TEXT,
        created_at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_long_lived_pending_actions_lookup
        ON long_lived_pending_actions(agent_id, status, expires_at);

      CREATE TABLE IF NOT EXISTS long_lived_action_audit (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id        TEXT NOT NULL,
        tick_id         TEXT,
        pending_action_id TEXT,
        action_kind     TEXT NOT NULL,
        action_target   TEXT NOT NULL,
        decision        TEXT NOT NULL,
        reason          TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_long_lived_action_audit_lookup
        ON long_lived_action_audit(agent_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS long_lived_cooldowns (
        agent_id      TEXT NOT NULL,
        action_target TEXT NOT NULL,
        until_at      INTEGER NOT NULL,
        reason        TEXT,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (agent_id, action_target)
      );

      CREATE TABLE IF NOT EXISTS memory_efficacy_cache (
        finding_id         TEXT PRIMARY KEY,
        synthesis_path     TEXT NOT NULL,
        ts                 TEXT NOT NULL,
        finding_index      INTEGER NOT NULL,
        finding_text       TEXT NOT NULL,
        severity           TEXT,
        classification     TEXT NOT NULL,
        classifier_model   TEXT NOT NULL,
        classified_at      TEXT NOT NULL,
        raw_response_json  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_efficacy_ts ON memory_efficacy_cache(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_efficacy_classification ON memory_efficacy_cache(classification);

      CREATE TABLE IF NOT EXISTS memory_efficacy_jobs (
        job_id            TEXT PRIMARY KEY,
        ts_enqueued       TEXT NOT NULL,
        ts_started        TEXT,
        ts_finished       TEXT,
        status            TEXT NOT NULL,
        since_iso         TEXT,
        reviews_dir       TEXT NOT NULL,
        scanned           INTEGER,
        classified        INTEGER,
        skipped           INTEGER,
        error_message     TEXT,
        enqueued_by       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_efficacy_jobs_status ON memory_efficacy_jobs(status, ts_enqueued);
    `);

    // Migrations on long_lived_agents must run AFTER its CREATE TABLE above —
    // the table lives inside this second db.exec block, so addColumnIfMissing
    // calls placed in the earlier migration cluster (~line 515) would ALTER a
    // table that does not yet exist on a fresh DB.
    addColumnIfMissing(db, 'long_lived_agents', 'snapshot_tool', 'TEXT');
    addColumnIfMissing(db, 'long_lived_agents', 'require_snapshot', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'long_lived_agents', 'project_id', 'TEXT');
    addColumnIfMissing(db, 'memory_efficacy_jobs', 'claimed_at', 'TEXT');
    addColumnIfMissing(db, 'memory_efficacy_jobs', 'claimed_by', 'TEXT');
    addColumnIfMissing(db, 'memory_efficacy_jobs', 'heartbeat_at', 'TEXT');
    addColumnIfMissing(db, 'memory_efficacy_jobs', 'lease_expires_at', 'TEXT');
    db.exec(`UPDATE memory_efficacy_jobs SET status = 'queued' WHERE status = 'pending'`);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function backfillHandoffRoots(db: Database): void {
  const allRows = db
    .query<{ handoff_id: string; parent_handoff_id: string | null; root_handoff_id: string | null }, []>(
      `SELECT handoff_id, parent_handoff_id, root_handoff_id FROM handoffs`,
    )
    .all();

  const parentMap = new Map<string, string | null>();
  const rootMap = new Map<string, string | null>();
  for (const r of allRows) {
    parentMap.set(r.handoff_id, r.parent_handoff_id);
    rootMap.set(r.handoff_id, r.root_handoff_id);
  }

  const needs = allRows.filter((r) => r.root_handoff_id == null);
  if (needs.length === 0) return;

  const MAX_DEPTH = 16;
  const updates: Array<[string, string]> = [];

  for (const row of needs) {
    if (rootMap.get(row.handoff_id) != null) continue;

    if (row.parent_handoff_id == null) {
      updates.push([row.handoff_id, row.handoff_id]);
      rootMap.set(row.handoff_id, row.handoff_id);
      continue;
    }

    const visited: string[] = [row.handoff_id];
    let cursor: string | null = row.parent_handoff_id;
    let resolvedRoot: string | null = null;
    let fallback: 'depth' | 'orphan' | null = null;

    while (true) {
      if (cursor == null) {
        resolvedRoot = visited[visited.length - 1]!;
        break;
      }
      const upstream = rootMap.get(cursor);
      if (upstream != null) {
        resolvedRoot = upstream;
        break;
      }
      if (!parentMap.has(cursor)) {
        fallback = 'orphan';
        break;
      }
      if (visited.length >= MAX_DEPTH) {
        fallback = 'depth';
        break;
      }
      visited.push(cursor);
      cursor = parentMap.get(cursor) ?? null;
    }

    if (fallback === 'orphan') {
      console.warn('[handoff-root-backfill] orphaned parent fallback: ' + row.handoff_id);
      updates.push([row.handoff_id, row.handoff_id]);
      rootMap.set(row.handoff_id, row.handoff_id);
      continue;
    }
    if (fallback === 'depth') {
      console.warn('[handoff-root-backfill] depth-cap fallback: ' + row.handoff_id);
      updates.push([row.handoff_id, row.handoff_id]);
      rootMap.set(row.handoff_id, row.handoff_id);
      continue;
    }

    for (const id of visited) {
      if (rootMap.get(id) == null) {
        updates.push([id, resolvedRoot!]);
        rootMap.set(id, resolvedRoot!);
      }
    }
  }

  const stmt = db.prepare(`UPDATE handoffs SET root_handoff_id = ? WHERE handoff_id = ?`);
  for (const [handoffId, rootId] of updates) {
    stmt.run(rootId, handoffId);
  }
}

export function addColumnIfMissing(db: Database, table: string, name: string, type: string): void {
  const exists = db
    .query<{ count: number }, [string, string]>(`SELECT COUNT(*) as count FROM pragma_table_info(?) WHERE name=?`)
    .get(table, name);
  if (exists && exists.count > 0) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('duplicate column name')) {
      throw err;
    }
  }
}

function ensureNullableMaestroSessionChainHandoffId(db: Database): void {
  const columns = db
    .query<{ name: string; notnull: number }, []>(`PRAGMA table_info('maestro_sessions')`)
    .all();
  const chainHandoffCol = columns.find((column) => column.name === 'chain_handoff_id');
  if (!chainHandoffCol || chainHandoffCol.notnull === 0) {
    return;
  }

  db.exec(`ALTER TABLE maestro_sessions RENAME TO maestro_sessions__legacy_notnull_chain`);
  db.exec(`
    CREATE TABLE maestro_sessions (
      task_id TEXT PRIMARY KEY,
      chain_handoff_id TEXT,
      agent_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      wall_clock_budget_ms INTEGER NOT NULL,
      cost_budget_cents INTEGER NOT NULL,
      sub_dispatch_budget INTEGER NOT NULL,
      cost_consumed_cents INTEGER NOT NULL DEFAULT 0,
      sub_dispatches_consumed INTEGER NOT NULL DEFAULT 0,
      soft_warned_at INTEGER,
      terminated_at INTEGER,
      termination_reason TEXT,
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );
  `);
  db.exec(`
    INSERT INTO maestro_sessions (
      task_id, chain_handoff_id, agent_id, started_at,
      wall_clock_budget_ms, cost_budget_cents, sub_dispatch_budget,
      cost_consumed_cents, sub_dispatches_consumed, soft_warned_at,
      terminated_at, termination_reason
    )
    SELECT
      task_id, chain_handoff_id, agent_id, started_at,
      wall_clock_budget_ms, cost_budget_cents, sub_dispatch_budget,
      cost_consumed_cents, sub_dispatches_consumed, soft_warned_at,
      terminated_at, termination_reason
    FROM maestro_sessions__legacy_notnull_chain;
  `);
  db.exec(`DROP TABLE maestro_sessions__legacy_notnull_chain`);
  db.exec(`CREATE INDEX IF NOT EXISTS maestro_sessions_chain_handoff_id ON maestro_sessions(chain_handoff_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS maestro_sessions_terminated_at ON maestro_sessions(terminated_at);`);
}
