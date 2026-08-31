import { Database } from "bun:sqlite";

// 42 = registrar entry_transition event kind.
// 41 = registrar entries, phases, and event journal.
export const SCHEMA_VERSION = 42;
const LANE_LEDGER_OPEN_DEDUPE_SCHEMA_META_KEY = "lane_ledger_open_dedupe_schema_version";
const T0_FTS_EXTERNAL_CONTENT_SCHEMA_META_KEY = "t0_fts_external_content_v1";

const SCHEMA_DDL_BLOCK_01 = `
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
      -- Cost reader's per_handoff CTEs filter t0_events by event_type='usage-update'
      -- over a time window; without this they full-scan the (multi-GB) table.
      CREATE INDEX IF NOT EXISTS t0_by_type_ts          ON t0_events(event_type, ts);
      -- dispatch-drift-guard counts a maestro session's trailing solo tool-call run:
      -- it filters by (session_id, event_type='agent-tool-use'). project_id is NOT a
      -- usable grouping key here — these rows carry a synthetic git-id with a
      -- per-subdirectory relpath suffix, so one session scatters across many
      -- project_ids. Without this index the query seeks by event_type alone (via
      -- t0_by_type_ts) and scans every agent-tool-use row across all sessions/time.
      CREATE INDEX IF NOT EXISTS t0_by_session_type_ts  ON t0_events(session_id, event_type, ts);
      CREATE INDEX IF NOT EXISTS t0_events_task_draft_lookup
        ON t0_events(project_id, event_type, ts, event_id)
        WHERE event_type IN (
          'task_draft','task_draft_refining','task_draft_promoted',
          'task_draft_stale','task_draft_duplicate','task_draft_escalation'
        );
      DROP INDEX IF EXISTS t0_events_task_draft_id_lookup;
      CREATE INDEX t0_events_task_draft_id_lookup
        ON t0_events(
          CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.draft_id') END,
          event_type,
          project_id,
          ts
        )
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
        failed_promotion_attempts INTEGER NOT NULL DEFAULT 0,
        promotion_filtered_at   TEXT
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
        updated_at         TEXT NOT NULL,
        retired_at         INTEGER
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
        authorized_by_handoff TEXT,
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
        requested_agent         TEXT,
        routing_resolution_reason TEXT,
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
        isolated_install        INTEGER,
        open_pr_on_review       INTEGER,
        branch_base             TEXT,
        branch_name             TEXT,
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
      CREATE INDEX IF NOT EXISTS task_events_kind_task ON task_events(kind, task_id);

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
        exec_ms              INTEGER,
        framework_overhead_ms INTEGER,
        source               TEXT NOT NULL,
        notes                TEXT,
        reliability_status   TEXT,
        failure_class        TEXT,
        artifact_present     TEXT,
        verification_present TEXT,
        maestro_takeover_required TEXT,
        empty_response       TEXT,
        worktree_changed     TEXT,
        reconcile_status     TEXT, -- deprecated: never written; do not adopt
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
      CREATE INDEX IF NOT EXISTS lane_ledger_by_implementer ON lane_ledger(implementer_handoff, ts_opened DESC);

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
      CREATE INDEX IF NOT EXISTS idx_dispatch_events_handoff_kind ON dispatch_events(handoff_id, kind);

      CREATE TABLE IF NOT EXISTS session_events (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        -- Nullable by design since first ship: absent hook session ids are stored as NULL, not a sentinel.
        session_id         TEXT,
        related_session_id TEXT,
        project_id         TEXT,
        cwd                TEXT,
        transcript_path    TEXT,
        ref_path           TEXT,
        kind               TEXT NOT NULL,
        ts                 TEXT NOT NULL,
        meta_json          TEXT,
        -- 8192 is deliberately larger than dispatch_events: boot_pickup carries first-moves JSON.
        CHECK (meta_json IS NULL OR length(meta_json) <= 8192)
      );
      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, ts);
      CREATE INDEX IF NOT EXISTS idx_session_events_kind_ts ON session_events(kind, ts);
      CREATE INDEX IF NOT EXISTS idx_session_events_ref ON session_events(ref_path);
      CREATE INDEX IF NOT EXISTS idx_session_events_related ON session_events(related_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_ts ON session_events(ts DESC, id DESC);

      CREATE TABLE IF NOT EXISTS subsystem_health (
        subsystem TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        seat TEXT,
        model TEXT,
        host TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_success_ts TEXT,
        last_failure_ts TEXT,
        last_failure_reason TEXT,
        last_failure_status INTEGER,
        first_non_primary_ts TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worker_tokens (
        token_hash    TEXT NOT NULL PRIMARY KEY,
        worker_id     TEXT NOT NULL,
        issued_at     INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        revoked_at    INTEGER NULL,
        metadata_json TEXT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_worker_tokens_worker
        ON worker_tokens(worker_id) WHERE revoked_at IS NULL;

`;
const SCHEMA_DDL_BLOCK_02 = `
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
`;
const SCHEMA_DDL_BLOCK_03 = `
      CREATE TABLE IF NOT EXISTS claude_code_sessions (
        session_id        TEXT PRIMARY KEY,
        session_start_at  TEXT NOT NULL,
        last_seen_at      TEXT NOT NULL,
        project_id        TEXT
      );
      CREATE INDEX IF NOT EXISTS claude_code_sessions_by_last_seen
        ON claude_code_sessions(last_seen_at DESC);
`;
const SCHEMA_DDL_BLOCK_04 = `
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
`;
const SCHEMA_DDL_BLOCK_05 = `
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
      DROP TRIGGER IF EXISTS t0_file_refs_insert;
      CREATE TRIGGER t0_file_refs_insert AFTER INSERT ON t0_events
      WHEN json_valid(new.payload_json)
        AND json_extract(new.payload_json, '$.tool_input.file_path') IS NOT NULL
      BEGIN
        INSERT OR IGNORE INTO t0_file_refs(event_id, file_path)
        VALUES (new.event_id, json_extract(new.payload_json, '$.tool_input.file_path'));
      END;
`;
const SCHEMA_DDL_BLOCK_06 = `
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
`;
const SCHEMA_DDL_BLOCK_07 = `
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
`;
const SCHEMA_DDL_BLOCK_08 = `
      INSERT INTO t1_fts(t1_fts) VALUES('rebuild');
      INSERT INTO t2_fts(t2_fts) VALUES('rebuild');
`;
const SCHEMA_DDL_BLOCK_09 = `
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
        meta_json           TEXT,
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
`;
const SCHEMA_DDL_BLOCK_10 = `
      CREATE TABLE IF NOT EXISTS dream_cycles (
        cycle_id              TEXT PRIMARY KEY,
        started_at            INTEGER NOT NULL,
        ended_at              INTEGER,
        project_id            TEXT,
        trigger               TEXT NOT NULL,
        -- Valid outcomes: running, bailed, completed, completed_with_curator_error, crashed
        outcome               TEXT NOT NULL DEFAULT 'running',
        bail_reason           TEXT,
        last_phase_completed  TEXT,
        budget_usd_cap        REAL NOT NULL,
        llm_spent_usd         REAL NOT NULL DEFAULT 0,
        embedding_spent_usd   REAL NOT NULL DEFAULT 0,
        research_spent_usd    REAL NOT NULL DEFAULT 0,
        phases_run            TEXT NOT NULL DEFAULT '[]',
        metadata_json         TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_dream_cycles_running ON dream_cycles(outcome) WHERE outcome = 'running';
      CREATE INDEX IF NOT EXISTS idx_dream_cycles_started ON dream_cycles(started_at);

      CREATE TABLE IF NOT EXISTS dream_actions (
        action_id        TEXT PRIMARY KEY,
        cycle_id         TEXT NOT NULL,
        phase            TEXT NOT NULL,
        action_type      TEXT NOT NULL,
        confidence       REAL NOT NULL,
        status           TEXT NOT NULL,
        target_ids       TEXT NOT NULL,
        payload_json     TEXT NOT NULL,
        untrusted_source INTEGER NOT NULL DEFAULT 0,
        decided_at       INTEGER,
        decided_by       TEXT,
        expires_at       INTEGER,
        reverted_by      TEXT,
        FOREIGN KEY (cycle_id) REFERENCES dream_cycles(cycle_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dream_actions_status  ON dream_actions(status);
      CREATE INDEX IF NOT EXISTS idx_dream_actions_cycle   ON dream_actions(cycle_id);
      CREATE INDEX IF NOT EXISTS idx_dream_actions_expires ON dream_actions(expires_at) WHERE status = 'queued';
      CREATE INDEX IF NOT EXISTS idx_dream_actions_queued_link_target ON dream_actions(target_ids) WHERE action_type = 'link' AND status = 'queued';
      CREATE INDEX IF NOT EXISTS idx_dream_actions_queued_promote_target ON dream_actions(target_ids) WHERE action_type = 'promote_t1' AND status = 'queued';

      CREATE TABLE IF NOT EXISTS memory_links (
        link_id          TEXT PRIMARY KEY,
        src_id           TEXT NOT NULL,
        dst_id           TEXT,
        link_type        TEXT NOT NULL,
        weight           REAL NOT NULL,
        minted_at        INTEGER NOT NULL,
        minted_by_cycle  TEXT NOT NULL,
        retired_at       INTEGER,
        metadata_json    TEXT NOT NULL DEFAULT '{}',
        raw_slug         TEXT,
        FOREIGN KEY (src_id)          REFERENCES t2_memories(memory_id),
        FOREIGN KEY (dst_id)          REFERENCES t2_memories(memory_id),
        FOREIGN KEY (minted_by_cycle) REFERENCES dream_cycles(cycle_id),
        UNIQUE(src_id, dst_id, link_type)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_links_src ON memory_links(src_id) WHERE retired_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_links_dst ON memory_links(dst_id) WHERE retired_at IS NULL;

      CREATE TABLE IF NOT EXISTS project_briefs (
        project_id           TEXT PRIMARY KEY,
        brief_md             TEXT NOT NULL,
        source_memory_ids    TEXT NOT NULL,
        generated_at         INTEGER NOT NULL,
        generated_by_cycle   TEXT NOT NULL,
        t2_shadow_memory_id  TEXT,
        FOREIGN KEY (generated_by_cycle)  REFERENCES dream_cycles(cycle_id),
        FOREIGN KEY (t2_shadow_memory_id) REFERENCES t2_memories(memory_id)
      );

      CREATE TABLE IF NOT EXISTS curator_ephemera_patterns (
        pattern_id   TEXT PRIMARY KEY,
        pattern      TEXT NOT NULL UNIQUE,
        reason       TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'queued',
        proposed_by  TEXT NOT NULL DEFAULT 'curator',
        proposed_at  INTEGER NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_curator_ephemera_status
        ON curator_ephemera_patterns(status) WHERE status='approved';

      CREATE TABLE IF NOT EXISTS t2_vec_history (
        history_id             TEXT PRIMARY KEY,
        memory_id              TEXT NOT NULL,
        embedding              BLOB NOT NULL,
        embedding_model_version TEXT NOT NULL,
        snapshotted_at         INTEGER NOT NULL,
        snapshotted_by_cycle   TEXT NOT NULL,
        FOREIGN KEY (memory_id)            REFERENCES t2_memories(memory_id),
        FOREIGN KEY (snapshotted_by_cycle) REFERENCES dream_cycles(cycle_id)
      );
      CREATE INDEX IF NOT EXISTS idx_t2_vec_history_memory ON t2_vec_history(memory_id);

      CREATE TABLE IF NOT EXISTS dream_research_cache (
        cache_key         TEXT PRIMARY KEY,
        provider          TEXT NOT NULL,
        project_id        TEXT NOT NULL,
        url               TEXT NOT NULL,
        query_hash        TEXT,
        title             TEXT,
        markdown          TEXT NOT NULL,
        fetched_at        INTEGER NOT NULL,
        expires_at        INTEGER NOT NULL,
        source_billed_usd REAL,
        metadata_json     TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_dream_research_cache_expires ON dream_research_cache(expires_at);
      CREATE INDEX IF NOT EXISTS idx_dream_research_cache_project ON dream_research_cache(project_id);

      CREATE TABLE IF NOT EXISTS dream_query_rewrites (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        t2_memory_id          TEXT NOT NULL,
        memory_updated_at_ms  INTEGER NOT NULL,
        verdict_kind          TEXT NOT NULL CHECK (verdict_kind IN ('query', 'skip')),
        query                 TEXT,
        reason                TEXT,
        model                 TEXT NOT NULL,
        expires_at            INTEGER NOT NULL,
        created_at            INTEGER NOT NULL,
        CHECK (verdict_kind != 'query' OR query IS NOT NULL),
        CHECK (verdict_kind != 'skip' OR reason IS NOT NULL),
        UNIQUE (t2_memory_id, memory_updated_at_ms, model),
        FOREIGN KEY (t2_memory_id) REFERENCES t2_memories(memory_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_dream_query_rewrites_t2_memory_id ON dream_query_rewrites(t2_memory_id);

      CREATE TABLE IF NOT EXISTS notification_outbox (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id    TEXT,
        kind          TEXT NOT NULL,
        reference_id  TEXT NOT NULL,
        summary       TEXT,
        payload_json  TEXT NOT NULL DEFAULT '{}',
        status        TEXT NOT NULL DEFAULT 'pending',
        created_at    INTEGER NOT NULL,
        coalesce_key  TEXT NOT NULL,
        attempted_at  INTEGER,
        completed_at  INTEGER,
        error         TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        deliver_after INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_kind_ref ON notification_outbox(kind, reference_id);
      CREATE INDEX IF NOT EXISTS notification_outbox_status_created ON notification_outbox(status, created_at);
      CREATE INDEX IF NOT EXISTS notification_outbox_coalesce ON notification_outbox(coalesce_key, status, created_at);

      CREATE TABLE IF NOT EXISTS curator_cursors (
        name       TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Fleet-global routing bias store. No user_context/RBAC column by decision.
      CREATE TABLE IF NOT EXISTS routing_bias (
        bias_id    TEXT PRIMARY KEY,
        scope      TEXT NOT NULL,
        value      TEXT NOT NULL,
        mode       TEXT NOT NULL,
        weight     REAL,
        reason     TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE(scope, value, mode)
      );
`;
const SCHEMA_DDL_BLOCK_11 = `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_links_unresolved
      ON memory_links(src_id, link_type, raw_slug)
      WHERE dst_id IS NULL AND raw_slug IS NOT NULL
`;
const SCHEMA_DDL_BLOCK_12 = `
      UPDATE memory_links
      SET raw_slug = lower(raw_slug)
      WHERE raw_slug IS NOT NULL
        AND raw_slug != lower(raw_slug)
`;
const SCHEMA_DDL_BLOCK_13 = `
      DROP TRIGGER IF EXISTS t0_fts_insert;
      DROP TRIGGER IF EXISTS t0_fts_delete;
      DROP TRIGGER IF EXISTS t0_events_payload_immutable_before_update;
      DROP TABLE IF EXISTS t0_fts;

      CREATE VIRTUAL TABLE t0_fts USING fts5(
        content,
        event_id UNINDEXED,
        content='t0_fts_src',
        content_rowid='rowid'
      );

      INSERT INTO t0_fts(t0_fts) VALUES('rebuild');

      CREATE TRIGGER t0_fts_insert AFTER INSERT ON t0_events BEGIN
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

      -- Delete balancing assumes payload_json/payload_summary never change after insert.
      CREATE TRIGGER t0_fts_delete AFTER DELETE ON t0_events BEGIN
        INSERT INTO t0_fts (t0_fts, rowid, content, event_id) VALUES (
          'delete',
          old.rowid,
          CASE
            WHEN json_valid(old.payload_json) THEN coalesce(
              json_extract(old.payload_json, '$.text'),
              json_extract(old.payload_json, '$.message'),
              json_extract(old.payload_json, '$.prompt'),
              json_extract(old.payload_json, '$.message_excerpt'),
              json_extract(old.payload_json, '$.response[0].text'),
              json_extract(old.payload_json, '$.response'),
              json_extract(old.payload_json, '$.input.text'),
              json_extract(old.payload_json, '$.input.message'),
              json_extract(old.payload_json, '$.input.prompt'),
              old.payload_summary,
              ''
            )
            ELSE coalesce(old.payload_summary, old.payload_json, '')
          END,
          old.event_id
        );
      END;
`;
const SCHEMA_DDL_BLOCK_14 = `
      CREATE TABLE IF NOT EXISTS routing_decisions (
        decision_id             TEXT PRIMARY KEY,
        ts                      TEXT NOT NULL,
        handoff_id              TEXT,
        mode                    TEXT NOT NULL,
        role                    TEXT,
        selected_agent          TEXT,
        selected_provider       TEXT,
        applied                 INTEGER NOT NULL,
        score                   REAL,
        confidence              REAL,
        predicted_cost_usd      REAL,
        predicted_latency_ms    INTEGER,
        task_profile_json       TEXT NOT NULL,
        factors_json            TEXT NOT NULL,
        alternatives_json       TEXT NOT NULL,
        fallback_chain_json     TEXT NOT NULL,
        data_freshness_json     TEXT NOT NULL,
        explanation_json        TEXT NOT NULL,
        router_schema_version   TEXT NOT NULL
      );
      DROP INDEX IF EXISTS idx_routing_decisions_handoff_id;
      CREATE INDEX IF NOT EXISTS idx_routing_decisions_handoff_id_ts ON routing_decisions(handoff_id, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_routing_decisions_ts ON routing_decisions(ts DESC);
`;
const SCHEMA_DDL_BLOCK_15 = `
      CREATE TABLE IF NOT EXISTS registrar_entries (
        registrar_id    TEXT PRIMARY KEY,
        slug            TEXT NOT NULL UNIQUE
                          CHECK (slug GLOB '[a-z]*' AND slug NOT GLOB '*[^a-z0-9-]*'),
        title           TEXT NOT NULL,
        home_project    TEXT NOT NULL,
        source_doc_path TEXT,
        status          TEXT NOT NULL CHECK (status IN ('draft','active','paused','complete','abandoned')),
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS registrar_phases (
        registrar_id TEXT NOT NULL REFERENCES registrar_entries(registrar_id),
        phase_no     INTEGER NOT NULL,
        title        TEXT NOT NULL,
        status       TEXT NOT NULL CHECK (status IN ('pending','active','blocked','complete','abandoned')),
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (registrar_id, phase_no)
      );

      CREATE TABLE IF NOT EXISTS registrar_events (
        event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
        registrar_id TEXT NOT NULL REFERENCES registrar_entries(registrar_id),
        phase_no     INTEGER,
        kind         TEXT NOT NULL CHECK (kind IN
                       ('progress','caveat','blocker','follow_up','decision','phase_transition','link','entry_transition')),
        state        TEXT,
        ref_event_id INTEGER REFERENCES registrar_events(event_id),
        link_kind    TEXT CHECK (link_kind IS NULL OR link_kind IN
                       ('commit_sha','handoff_id','lane_id','workflow_run_id','memory_id','plan_id','gh_issue')),
        link_value   TEXT,
        actor        TEXT NOT NULL CHECK (actor IN ('maestro','worker','sweeper','operator')),
        body         TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 4096),
        created_at   INTEGER NOT NULL,
        CHECK ((kind = 'blocker'          AND state IN ('opened','resolved'))
            OR (kind = 'follow_up'        AND state IN ('owed','done','dropped'))
            OR (kind = 'phase_transition' AND state IN ('pending','active','blocked','complete','abandoned'))
            OR (kind = 'entry_transition' AND state IN ('active','paused','complete','abandoned'))
            OR (kind NOT IN ('blocker','follow_up','phase_transition','entry_transition') AND state IS NULL)),
        CHECK (kind != 'link' OR (link_kind IS NOT NULL AND link_value IS NOT NULL)),
        CHECK (state NOT IN ('resolved','done','dropped') OR ref_event_id IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS registrar_events_by_entry ON registrar_events(registrar_id, created_at);
      CREATE INDEX IF NOT EXISTS registrar_events_open_state ON registrar_events(registrar_id, kind, state);
`;

export interface ReleaseT1RollupClaimsOpts {
  terminalOutcomes?: readonly string[];
  staleBeforeMs?: number;
  cycleIds?: readonly string[];
}

const HANDOFFS_ADDITIVE_COLUMNS: [string, string][] = [
  ["chain_max_hops", "INTEGER"],
  ["chain_trust_mode", "TEXT"],
  ["chain_task_type", "TEXT"],
  ["dispatch_kind", "TEXT"],
  ["long_lived_agent_id", "TEXT"],
  ["long_lived_tick_id", "TEXT"],
  ["use_worktree", "INTEGER"],
  ["isolated_install", "INTEGER"],
  ["open_pr_on_review", "INTEGER"],
  ["branch_base", "TEXT"],
  ["branch_name", "TEXT"],
  ["resolution_reason", "TEXT"],
  ["error_message", "TEXT"],
  ["cancel_requested_at", "TEXT"],
  ["worker_id", "TEXT"],
  ["parent_handoff_id", "TEXT"],
  ["root_handoff_id", "TEXT"],
  ["requested_agent", "TEXT"],
  ["routing_resolution_reason", "TEXT"],
  ["dispatch_attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["max_dispatch_attempts", "INTEGER NOT NULL DEFAULT 3"],
  ["last_dispatch_started_at", "TEXT"],
  ["workflow_run_id", "TEXT"],
];

const TASKS_ADDITIVE_COLUMNS: [string, string][] = [
  ["branch_base", "TEXT"],
  ["gh_issue_number", "INTEGER"],
  ["gh_issue_repo", "TEXT"],
  ["gh_last_comment_id", "TEXT"],
  ["gh_comments_synced_at", "INTEGER"],
  ["gh_create_status", "TEXT"],
  ["gh_create_error", "TEXT"],
];

const AGENT_PERFORMANCE_ADDITIVE_COLUMNS: [string, string][] = [
  ["reliability_status", "TEXT"],
  ["failure_class", "TEXT"],
  ["artifact_present", "TEXT"],
  ["verification_present", "TEXT"],
  ["maestro_takeover_required", "TEXT"],
  ["empty_response", "TEXT"],
  ["worktree_changed", "TEXT"],
  // deprecated: dead column, never written — see AgentPerformanceRowSchema.reconcile_status
  ["reconcile_status", "TEXT"],
  ["environment_failure", "TEXT"],
  ["trust_score", "REAL"],
  ["agent_kind", "TEXT"],
  ["gate_outcome", "TEXT"],
  ["exec_ms", "INTEGER"],
  ["framework_overhead_ms", "INTEGER"],
];

const WORKFLOW_STATS_ADDITIVE_COLUMNS: [string, string][] = [
  ["refresh_runs", "INTEGER NOT NULL DEFAULT 0"],
  ["intentional_runs", "INTEGER NOT NULL DEFAULT 0"],
];

const WORKFLOW_RUNS_ADDITIVE_COLUMNS: [string, string][] = [
  ["result_spill_path", "TEXT"],
  ["error_spill_path", "TEXT"],
  ["expires_at", "INTEGER NOT NULL DEFAULT 0"],
  ["result_bytes", "INTEGER NOT NULL DEFAULT 0"],
  ["error_bytes", "INTEGER NOT NULL DEFAULT 0"],
];

const T2_MEMORIES_ADDITIVE_COLUMNS: [string, string][] = [
  ["slug", "TEXT"],
  ["hook", "TEXT"],
  ["sub_kind", "TEXT"],
  ["cc_kind", "TEXT"],
  ["obs_type", "TEXT"],
  ["concepts", "TEXT"],
  ["severity", "TEXT"],
  ["file_paths", "TEXT"],
  ["last_verified_at", "TEXT"],
  ["last_verified_by", "TEXT"],
  ["last_verified_actor", "TEXT"],
  ["last_verified_reason", "TEXT"],
  ["last_verified_session_id", "TEXT"],
  ["why", "TEXT"],
  ["source_quote", "TEXT"],
  ["learned_at", "TEXT"],
  ["durability", "TEXT"],
  ["depth", "INTEGER"],
  ["is_episodic", "INTEGER NOT NULL DEFAULT 0"],
  ["decay_score", "REAL"],
  ["decay_scored_at", "TEXT"],
  ["archived_at", "TEXT"],
];

const T2_MEMORY_VERIFICATION_ADDITIVE_COLUMNS: [string, string][] = [
  ["basis", "TEXT"],
  ["basis_type", "TEXT"],
  ["basis_detail", "TEXT"],
  ["authorized_by_handoff", "TEXT"],
];

const LONG_LIVED_ADDITIVE_COLUMNS: [string, [string, string][]][] = [
  [
    "long_lived_agents",
    [
      ["snapshot_tool", "TEXT"],
      ["require_snapshot", "INTEGER NOT NULL DEFAULT 0"],
      ["project_id", "TEXT"],
    ],
  ],
  ["long_lived_pending_actions", [["meta_json", "TEXT"]]],
  [
    "memory_efficacy_jobs",
    [
      ["claimed_at", "TEXT"],
      ["claimed_by", "TEXT"],
      ["heartbeat_at", "TEXT"],
      ["lease_expires_at", "TEXT"],
    ],
  ],
];

const T1_ROLLUPS_LATE_ADDITIVE_COLUMNS: [string, string][] = [
  ["claimed_at", "INTEGER"],
  ["claimed_by_cycle", "TEXT"],
  ["embedding_model_version", "TEXT"],
];

function addColumnsIfMissing(db: Database, table: string, cols: [string, string][]): void {
  for (const [name, type] of cols) {
    addColumnIfMissing(db, table, name, type);
  }
}

function applyHandoffsMigration(db: Database): void {
  addColumnsIfMissing(db, "handoffs", HANDOFFS_ADDITIVE_COLUMNS);
  db.run(
    `CREATE INDEX IF NOT EXISTS handoffs_status_worker_ts ON handoffs(status, worker_id, ts);`,
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_handoffs_root_status ON handoffs(status, root_handoff_id);`,
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS handoffs_root_by_conv ON handoffs(conversation_id, ts) WHERE parent_handoff_id IS NULL;`,
  );
  backfillHandoffRoots(db);
  dedupeOpenLaneLedgerRowsOnce(db);
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS lane_ledger_one_open_per_implementer
       ON lane_ledger(implementer_handoff)
       WHERE ts_closed IS NULL;`,
  );
}

function applyTasksMigration(db: Database): void {
  addColumnsIfMissing(db, "tasks", TASKS_ADDITIVE_COLUMNS);
  db.run(
    `CREATE INDEX IF NOT EXISTS tasks_by_gh ON tasks(gh_issue_repo, gh_issue_number) WHERE gh_issue_number IS NOT NULL;`,
  );
  addColumnIfMissing(db, "task_leases", "original_ttl_ms", "INTEGER");
}

function applyWorkflowsMigration(db: Database): void {
  addColumnsIfMissing(db, "workflow_stats", WORKFLOW_STATS_ADDITIVE_COLUMNS);
  addColumnsIfMissing(db, "workflow_runs", WORKFLOW_RUNS_ADDITIVE_COLUMNS);
  db.run(
    `UPDATE workflow_runs
        SET result_bytes = length(CAST(result_json AS BLOB))
      WHERE result_json IS NOT NULL
        AND result_bytes = 0;`,
  );
  db.run(
    `UPDATE workflow_runs
        SET error_bytes = length(CAST(error_json AS BLOB))
      WHERE error_json IS NOT NULL
        AND error_bytes = 0;`,
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS workflow_runs_project_id ON workflow_runs(project_id, status, started_at DESC);`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS workflow_runs_expires_at ON workflow_runs(expires_at);`);
  ensureNullableMaestroSessionChainHandoffId(db);
}

function applyOriginTaggingMigration(db: Database): void {
  addColumnIfMissing(db, "t0_events", "origin", "TEXT");
  addColumnIfMissing(db, "t1_rollups", "origin", "TEXT");
  addColumnIfMissing(db, "t2_memories", "origin", "TEXT");
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_t2_origin ON t2_memories(origin) WHERE origin IS NOT NULL`,
  );
}

function applyT1RollupsMigration(db: Database): void {
  addColumnIfMissing(db, "t1_rollups", "t2_promoted_at", "TEXT");
  addColumnIfMissing(db, "t1_rollups", "failed_promotion_attempts", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "t1_rollups", "promotion_filtered_at", "TEXT");
  const legacyPromotionSkippedColumn = db
    .query<
      { count: number },
      [string, string]
    >(`SELECT COUNT(*) as count FROM pragma_table_info(?) WHERE name=?`)
    .get("t1_rollups", "promotion_skipped_at");
  if (legacyPromotionSkippedColumn && legacyPromotionSkippedColumn.count > 0) {
    db.run(`
      UPDATE t1_rollups
         SET promotion_filtered_at = promotion_skipped_at
       WHERE promotion_filtered_at IS NULL
         AND promotion_skipped_at IS NOT NULL;
    `);
  }
  db.run(
    `CREATE INDEX IF NOT EXISTS t1_unpromoted_idx ON t1_rollups(ended_at) WHERE t2_promoted_at IS NULL`,
  );
}

function applyT2MemoriesMigration(db: Database): void {
  addColumnsIfMissing(db, "t2_memories", T2_MEMORIES_ADDITIVE_COLUMNS);
  addColumnsIfMissing(db, "t2_memory_verification_events", T2_MEMORY_VERIFICATION_ADDITIVE_COLUMNS);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_t2_obs_type ON t2_memories(obs_type) WHERE obs_type IS NOT NULL`,
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_t2_severity ON t2_memories(severity) WHERE severity IS NOT NULL`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS t2_memory_verification_events_basis_type
    ON t2_memory_verification_events(basis_type)
    WHERE basis_type IS NOT NULL`);
}

function applyLongLivedMigration(db: Database): void {
  for (const [table, cols] of LONG_LIVED_ADDITIVE_COLUMNS) {
    addColumnsIfMissing(db, table, cols);
  }
  db.run(`UPDATE memory_efficacy_jobs SET status = 'queued' WHERE status = 'pending'`);
}

function applyRoutingAndNotificationsMigration(db: Database): void {
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_routing_bias_scope_expiry ON routing_bias(scope, expires_at)`,
  );
  addColumnIfMissing(db, "notification_outbox", "attempt_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "notification_outbox", "deliver_after", "INTEGER");
  addColumnIfMissing(db, "dream_research_cache", "is_negative", "INTEGER NOT NULL DEFAULT 0");
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_dream_research_cache_negative ON dream_research_cache(cache_key) WHERE is_negative = 1`,
  );
}

function applyLateMemoryMigration(db: Database): void {
  addColumnsIfMissing(db, "t1_rollups", T1_ROLLUPS_LATE_ADDITIVE_COLUMNS);
  addColumnIfMissing(db, "t2_memories", "embedding_model_version", "TEXT");
  addColumnIfMissing(db, "t2_memories", "retired_at", "INTEGER");
  db.run(`DROP INDEX IF EXISTS idx_t2_memories_slug`);
  db.run(`DROP INDEX IF EXISTS idx_t2_slug`);
  addColumnIfMissing(db, "memory_links", "raw_slug", "TEXT");
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_t2_slug ON t2_memories(COALESCE(project_id, '__none__'), slug) WHERE slug IS NOT NULL`,
  );
}

function applyMemoryLinksNullableMigration(db: Database): void {
  const dstIdNotNull = db
    .query<
      { notnull: number },
      []
    >(`SELECT "notnull" FROM pragma_table_info('memory_links') WHERE name='dst_id'`)
    .get();
  if (dstIdNotNull?.notnull !== 1) return;
  db.run(`
    CREATE TABLE memory_links_new (
      link_id          TEXT PRIMARY KEY,
      src_id           TEXT NOT NULL,
      dst_id           TEXT,
      link_type        TEXT NOT NULL,
      weight           REAL NOT NULL,
      minted_at        INTEGER NOT NULL,
      minted_by_cycle  TEXT NOT NULL,
      retired_at       INTEGER,
      metadata_json    TEXT NOT NULL DEFAULT '{}',
      raw_slug         TEXT,
      FOREIGN KEY (src_id)          REFERENCES t2_memories(memory_id),
      FOREIGN KEY (dst_id)          REFERENCES t2_memories(memory_id),
      FOREIGN KEY (minted_by_cycle) REFERENCES dream_cycles(cycle_id),
      UNIQUE(src_id, dst_id, link_type)
    )
  `);
  db.run(`INSERT INTO memory_links_new SELECT * FROM memory_links`);
  db.run(`DROP TABLE memory_links`);
  db.run(`ALTER TABLE memory_links_new RENAME TO memory_links`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_memory_links_src ON memory_links(src_id) WHERE retired_at IS NULL`,
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_memory_links_dst ON memory_links(dst_id) WHERE retired_at IS NULL`,
  );
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_links_unresolved
    ON memory_links(src_id, link_type, raw_slug)
    WHERE dst_id IS NULL AND raw_slug IS NOT NULL
  `);
}

function applyTasksProjectIdColumn(db: Database): void {
  const taskColumns = db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all();
  if (!taskColumns.some((column) => column.name === "project_id")) {
    db.run("ALTER TABLE tasks ADD COLUMN project_id TEXT");
  }
}

export function applySchema(db: Database, opts: { embeddingDim?: number } = {}): void {
  const dim = opts.embeddingDim ?? 384;
  db.run("BEGIN");
  try {
    db.run(SCHEMA_DDL_BLOCK_01);
    db.run(SCHEMA_DDL_BLOCK_02);
    db.run(SCHEMA_DDL_BLOCK_03);
    db.run(SCHEMA_DDL_BLOCK_04);
    migrateT0FtsToExternalContentOnce(db);
    db.run(SCHEMA_DDL_BLOCK_05);
    db.run(SCHEMA_DDL_BLOCK_06);
    applyTasksProjectIdColumn(db);
    db.run(SCHEMA_DDL_BLOCK_07);
    db.run(SCHEMA_DDL_BLOCK_08);
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS t1_vec USING vec0(embedding FLOAT[${String(dim)}])`);
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS t2_vec USING vec0(embedding FLOAT[${String(dim)}])`);
    applyHandoffsMigration(db);
    applyTasksMigration(db);
    addColumnsIfMissing(db, "agent_performance", AGENT_PERFORMANCE_ADDITIVE_COLUMNS);
    applyWorkflowsMigration(db);
    applyOriginTaggingMigration(db);
    applyT1RollupsMigration(db);
    applyT2MemoriesMigration(db);
    db.run(SCHEMA_DDL_BLOCK_09);
    applyLongLivedMigration(db);
    db.run(SCHEMA_DDL_BLOCK_10);
    applyRoutingAndNotificationsMigration(db);
    applyLateMemoryMigration(db);
    db.run(SCHEMA_DDL_BLOCK_11);
    applyMemoryLinksNullableMigration(db);
    db.run(SCHEMA_DDL_BLOCK_12);
    db.run(SCHEMA_DDL_BLOCK_14);
    db.run(SCHEMA_DDL_BLOCK_15);
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
  // Run OUTSIDE the main transaction: the dream_query_rewrites rebuild copies rows
  // (including any orphaned t2_memory_id) into a table declaring a FOREIGN KEY to
  // t2_memories, which is only safe with PRAGMA foreign_keys=OFF — and SQLite silently
  // ignores foreign_keys changes while a transaction is open. Toggling it here (no
  // enclosing transaction) keeps the FK-disable effective so an orphaned row upgrades
  // instead of crashing applySchema on a FOREIGN KEY violation.
  migrateDreamQueryRewritesToModelScopedKeys(db);
  // Same envelope: registrar_events declares a self-referencing FK, so the rebuild
  // also runs with FK enforcement off, outside the main transaction.
  ensureRegistrarEventsEntryTransitionKind(db);
}

function createT0FtsSrcView(db: Database): void {
  db.run(`
    CREATE VIEW IF NOT EXISTS t0_fts_src AS
      SELECT t0_events.rowid AS rowid,
             CASE
               WHEN json_valid(payload_json) THEN coalesce(
                 json_extract(payload_json, '$.text'),
                 json_extract(payload_json, '$.message'),
                 json_extract(payload_json, '$.prompt'),
                 json_extract(payload_json, '$.message_excerpt'),
                 json_extract(payload_json, '$.response[0].text'),
                 json_extract(payload_json, '$.response'),
                 json_extract(payload_json, '$.input.text'),
                 json_extract(payload_json, '$.input.message'),
                 json_extract(payload_json, '$.input.prompt'),
                 payload_summary,
                 ''
               )
               ELSE coalesce(payload_summary, payload_json, '')
             END AS content,
             event_id
        FROM t0_events;
  `);
}

function createT0PayloadImmutabilityTrigger(db: Database): void {
  db.run(`
    CREATE TRIGGER IF NOT EXISTS t0_events_payload_immutable_before_update
    BEFORE UPDATE OF payload_json, payload_summary ON t0_events
    BEGIN
      SELECT RAISE(ABORT, 'payload_json is immutable post-insert; payload_summary is immutable post-insert; external-content t0_fts would corrupt');
    END;
  `);
}

export function migrateT0FtsToExternalContentOnce(db: Database): void {
  const marker = db
    .query<{ value: string }, [string]>("SELECT value FROM db_meta WHERE key = ?")
    .get(T0_FTS_EXTERNAL_CONTENT_SCHEMA_META_KEY);
  if (marker) {
    createT0FtsSrcView(db);
    createT0PayloadImmutabilityTrigger(db);
    return;
  }

  db.run("SAVEPOINT t0_fts_external_content_migration");
  try {
    createT0FtsSrcView(db);
    db.run(SCHEMA_DDL_BLOCK_13);
    createT0PayloadImmutabilityTrigger(db);
    db.run("INSERT OR REPLACE INTO db_meta(key, value) VALUES(?, ?)", [
      T0_FTS_EXTERNAL_CONTENT_SCHEMA_META_KEY,
      "1",
    ]);
    db.run("RELEASE SAVEPOINT t0_fts_external_content_migration");
  } catch (err) {
    db.run("ROLLBACK TO SAVEPOINT t0_fts_external_content_migration");
    db.run("RELEASE SAVEPOINT t0_fts_external_content_migration");
    throw err;
  }
}

interface HandoffRootRow {
  handoff_id: string;
  parent_handoff_id: string | null;
  root_handoff_id: string | null;
}

interface RootWalkResult {
  resolvedRoot: string | null;
  visited: string[];
  fallback: "depth" | "orphan" | null;
}

const HANDOFF_ROOT_MAX_DEPTH = 16;

function walkRootForHandoff(
  row: HandoffRootRow,
  parentMap: Map<string, string | null>,
  rootMap: Map<string, string | null>,
): RootWalkResult {
  const visited: string[] = [row.handoff_id];
  let cursor: string | null = row.parent_handoff_id;

  for (;;) {
    if (cursor === null) {
      const last = visited[visited.length - 1];
      return { resolvedRoot: last ?? row.handoff_id, visited, fallback: null };
    }
    const upstream = rootMap.get(cursor) ?? null;
    if (upstream !== null) {
      return { resolvedRoot: upstream, visited, fallback: null };
    }
    if (!parentMap.has(cursor)) {
      return { resolvedRoot: null, visited, fallback: "orphan" };
    }
    if (visited.length >= HANDOFF_ROOT_MAX_DEPTH) {
      return { resolvedRoot: null, visited, fallback: "depth" };
    }
    visited.push(cursor);
    cursor = parentMap.get(cursor) ?? null;
  }
}

function resolveHandoffRoot(
  row: HandoffRootRow,
  parentMap: Map<string, string | null>,
  rootMap: Map<string, string | null>,
  updates: [string, string][],
): void {
  if ((rootMap.get(row.handoff_id) ?? null) !== null) return;

  if (row.parent_handoff_id === null) {
    updates.push([row.handoff_id, row.handoff_id]);
    rootMap.set(row.handoff_id, row.handoff_id);
    return;
  }

  const walk = walkRootForHandoff(row, parentMap, rootMap);

  if (walk.fallback === "orphan") {
    console.warn(`[handoff-root-backfill] orphaned parent fallback: ${row.handoff_id}`);
    updates.push([row.handoff_id, row.handoff_id]);
    rootMap.set(row.handoff_id, row.handoff_id);
    return;
  }
  if (walk.fallback === "depth") {
    console.warn(`[handoff-root-backfill] depth-cap fallback: ${row.handoff_id}`);
    updates.push([row.handoff_id, row.handoff_id]);
    rootMap.set(row.handoff_id, row.handoff_id);
    return;
  }

  const resolved = walk.resolvedRoot;
  if (resolved === null) return;
  for (const id of walk.visited) {
    if ((rootMap.get(id) ?? null) === null) {
      updates.push([id, resolved]);
      rootMap.set(id, resolved);
    }
  }
}

function backfillHandoffRoots(db: Database): void {
  const allRows = db
    .query<
      HandoffRootRow,
      []
    >(`SELECT handoff_id, parent_handoff_id, root_handoff_id FROM handoffs`)
    .all();

  const parentMap = new Map<string, string | null>();
  const rootMap = new Map<string, string | null>();
  for (const r of allRows) {
    parentMap.set(r.handoff_id, r.parent_handoff_id);
    rootMap.set(r.handoff_id, r.root_handoff_id);
  }

  const needs = allRows.filter((r) => r.root_handoff_id === null);
  if (needs.length === 0) return;

  const updates: [string, string][] = [];
  for (const row of needs) {
    resolveHandoffRoot(row, parentMap, rootMap, updates);
  }

  const stmt = db.prepare(`UPDATE handoffs SET root_handoff_id = ? WHERE handoff_id = ?`);
  for (const [handoffId, rootId] of updates) {
    stmt.run(rootId, handoffId);
  }
}

function dedupeOpenLaneLedgerRowsOnce(db: Database): void {
  const marker = db
    .query<{ value: string }, [string]>("SELECT value FROM db_meta WHERE key = ?")
    .get(LANE_LEDGER_OPEN_DEDUPE_SCHEMA_META_KEY);
  if (marker?.value === String(SCHEMA_VERSION)) return;

  // Errors propagate deliberately: the unique-index creation that follows
  // would otherwise crash startup with a misattributed UNIQUE-constraint
  // failure when leftover duplicates survive a swallowed dedupe error.
  dedupeOpenLaneLedgerRows(db, new Date(Date.now()).toISOString());
  db.run(
    "INSERT INTO db_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [LANE_LEDGER_OPEN_DEDUPE_SCHEMA_META_KEY, String(SCHEMA_VERSION)],
  );
}

function dedupeOpenLaneLedgerRows(db: Database, tsClosed: string): void {
  db.run(
    `
    WITH ranked_open_lanes AS (
      SELECT
        lane_id,
        FIRST_VALUE(lane_id) OVER (
          PARTITION BY implementer_handoff
          ORDER BY ts_opened DESC, lane_id DESC
        ) AS keep_lane_id,
        FIRST_VALUE(ts_opened) OVER (
          PARTITION BY implementer_handoff
          ORDER BY ts_opened DESC, lane_id DESC
        ) AS keep_ts_opened,
        COUNT(*) OVER (PARTITION BY implementer_handoff) AS open_count
      FROM lane_ledger
      WHERE ts_closed IS NULL
    )
    UPDATE lane_ledger
    SET
      ts_closed = ?,
      gate_status = 'skipped',
      override_reason = 'schema dedupe: duplicate open lane superseded by ' || (
        SELECT keep_lane_id
        FROM ranked_open_lanes
        WHERE ranked_open_lanes.lane_id = lane_ledger.lane_id
      )
    WHERE lane_id IN (
      SELECT lane_id
      FROM ranked_open_lanes
      WHERE open_count > 1
        AND lane_id != keep_lane_id
    )
  `,
    [tsClosed],
  );
}

export function addColumnIfMissing(db: Database, table: string, name: string, type: string): void {
  const exists = db
    .query<
      { count: number },
      [string, string]
    >(`SELECT COUNT(*) as count FROM pragma_table_info(?) WHERE name=?`)
    .get(table, name);
  if (exists && exists.count > 0) return;
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("duplicate column name")) {
      throw err;
    }
  }
}

const DREAM_QR_MODEL_SCOPED_KEYS_META_KEY = "dream_query_rewrites_model_scoped_keys_v1";

function markDreamQueryRewritesMigrated(db: Database): void {
  db.run("INSERT OR REPLACE INTO db_meta(key, value) VALUES(?, ?)", [
    DREAM_QR_MODEL_SCOPED_KEYS_META_KEY,
    "1",
  ]);
}

function migrateDreamQueryRewritesToModelScopedKeys(db: Database): void {
  // Idempotency: a db_meta marker (not a brittle PRAGMA index_list probe) records that
  // this rewrite already ran, so a re-boot returns immediately and the table's sqlite_master
  // rowid stays stable across restarts.
  const alreadyMigrated = db
    .query<{ value: string }, [string]>("SELECT value FROM db_meta WHERE key = ?")
    .get(DREAM_QR_MODEL_SCOPED_KEYS_META_KEY);
  if (alreadyMigrated) return;

  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(dream_query_rewrites)`).all();
  if (columns.length === 0) {
    markDreamQueryRewritesMigrated(db);
    return;
  }

  const hasReason = columns.some((column) => column.name === "reason");
  const hasSkipReason = columns.some((column) => column.name === "skip_reason");
  const hasModel = columns.some((column) => column.name === "model");

  const uniqueIndexes = db
    .query<{ name: string; unique: number }, []>(`PRAGMA index_list('dream_query_rewrites')`)
    .all();
  const hasModelScopedUnique = uniqueIndexes.some((index) => {
    if (index.name === "sqlite_autoindex_dream_query_rewrites_1") {
      return false;
    }
    if (index.unique !== 1) {
      return false;
    }
    const indexInfo = db.query<{ name: string }, []>(`PRAGMA index_info("${index.name}")`).all();
    if (indexInfo.length !== 3) return false;
    const indexCols = indexInfo.map((column) => column.name);
    return (
      indexCols[0] === "t2_memory_id" &&
      indexCols[1] === "memory_updated_at_ms" &&
      indexCols[2] === "model" &&
      index.name.includes("dream_query_rewrites")
    );
  });

  if (hasReason && hasModel && hasModelScopedUnique) {
    markDreamQueryRewritesMigrated(db);
    return;
  }

  const reasonSource = hasReason
    ? hasSkipReason
      ? "COALESCE(reason, skip_reason)"
      : "reason"
    : hasSkipReason
      ? "skip_reason"
      : "NULL";

  // PRAGMA foreign_keys must be toggled OUTSIDE a transaction to take effect. This
  // function is invoked after applySchema's COMMIT, so there is no enclosing transaction:
  // disable FK enforcement, then open our own transaction for the rebuild. Capture the
  // prior FK state and restore it in finally so we never leave enforcement in the wrong
  // mode on any error path.
  const fkState = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
  const restoreForeignKeys = fkState?.foreign_keys === 0 ? "OFF" : "ON";
  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.run("BEGIN");
    try {
      db.run(`ALTER TABLE dream_query_rewrites RENAME TO dream_query_rewrites_v27`);
      db.run(`
        CREATE TABLE dream_query_rewrites (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          t2_memory_id          TEXT NOT NULL,
          memory_updated_at_ms  INTEGER NOT NULL,
          verdict_kind          TEXT NOT NULL CHECK (verdict_kind IN ('query', 'skip')),
          query                 TEXT,
          reason                TEXT,
          model                 TEXT NOT NULL,
          expires_at            INTEGER NOT NULL,
          created_at            INTEGER NOT NULL,
          CHECK (verdict_kind != 'query' OR query IS NOT NULL),
          CHECK (verdict_kind != 'skip' OR reason IS NOT NULL),
          UNIQUE (t2_memory_id, memory_updated_at_ms, model),
          FOREIGN KEY (t2_memory_id) REFERENCES t2_memories(memory_id) ON DELETE CASCADE
        )
      `);
      db.run(`INSERT INTO dream_query_rewrites(
        t2_memory_id, memory_updated_at_ms, verdict_kind, query, reason, model, expires_at, created_at
      )
      SELECT
        t2_memory_id,
        memory_updated_at_ms,
        verdict_kind,
        query,
        ${reasonSource},
        COALESCE(model, 'granite-4.1-3b'),
        expires_at,
        created_at
      FROM dream_query_rewrites_v27
      WHERE (verdict_kind != 'query' OR query IS NOT NULL)
        AND (verdict_kind != 'skip' OR ${reasonSource} IS NOT NULL)
      `);
      db.run(`DROP TABLE dream_query_rewrites_v27`);
      db.run(`DROP INDEX IF EXISTS idx_dream_query_rewrites_t2_memory_id`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_dream_query_rewrites_t2_memory_id
        ON dream_query_rewrites(t2_memory_id)`);
      markDreamQueryRewritesMigrated(db);
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
  } finally {
    db.run(`PRAGMA foreign_keys = ${restoreForeignKeys}`);
  }
}

function ensureRegistrarEventsEntryTransitionKind(db: Database): void {
  // Self-auditing: fresh databases created at v42 already carry the kind in their
  // sqlite_master DDL, so probe the stored CREATE statement instead of a db_meta marker.
  const tableSql = db
    .query<
      { sql: string },
      []
    >("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'registrar_events'")
    .get();
  if (!tableSql || tableSql.sql.includes("entry_transition")) return;

  const oversizedBodies = db
    .query<
      { event_id: number },
      []
    >("SELECT event_id FROM registrar_events WHERE length(CAST(body AS BLOB)) > 4096 LIMIT 10")
    .all();
  if (oversizedBodies.length > 0) {
    const eventIds = oversizedBodies.map((row) => String(row.event_id)).join(", ");
    throw new Error(
      `registrar_events contains bodies over 4096 bytes for event_id(s): ${eventIds}; shorten these bodies below 4096 bytes, then restart`,
    );
  }
  const oldSequence =
    db
      .query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'registrar_events'")
      .get()?.seq ?? 0;

  // Mirror migrateDreamQueryRewritesToModelScopedKeys: registrar_events has a
  // self-referencing FK, and PRAGMA foreign_keys is ignored inside an open
  // transaction, so toggle it here (no enclosing transaction) and restore in finally.
  const fkState = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
  const restoreForeignKeys = fkState?.foreign_keys === 0 ? "OFF" : "ON";
  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.run("BEGIN");
    try {
      db.run("ALTER TABLE registrar_events RENAME TO registrar_events__pre_entry_transition");
      db.run(`
      CREATE TABLE registrar_events (
        event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
        registrar_id TEXT NOT NULL REFERENCES registrar_entries(registrar_id),
        phase_no     INTEGER,
        kind         TEXT NOT NULL CHECK (kind IN
                       ('progress','caveat','blocker','follow_up','decision','phase_transition','link','entry_transition')),
        state        TEXT,
        ref_event_id INTEGER REFERENCES registrar_events(event_id),
        link_kind    TEXT CHECK (link_kind IS NULL OR link_kind IN
                       ('commit_sha','handoff_id','lane_id','workflow_run_id','memory_id','plan_id','gh_issue')),
        link_value   TEXT,
        actor        TEXT NOT NULL CHECK (actor IN ('maestro','worker','sweeper','operator')),
        body         TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 4096),
        created_at   INTEGER NOT NULL,
        CHECK ((kind = 'blocker'          AND state IN ('opened','resolved'))
            OR (kind = 'follow_up'        AND state IN ('owed','done','dropped'))
            OR (kind = 'phase_transition' AND state IN ('pending','active','blocked','complete','abandoned'))
            OR (kind = 'entry_transition' AND state IN ('active','paused','complete','abandoned'))
            OR (kind NOT IN ('blocker','follow_up','phase_transition','entry_transition') AND state IS NULL)),
        CHECK (kind != 'link' OR (link_kind IS NOT NULL AND link_value IS NOT NULL)),
        CHECK (state NOT IN ('resolved','done','dropped') OR ref_event_id IS NOT NULL)
      );`);
      db.run(`
        INSERT INTO registrar_events (
          event_id, registrar_id, phase_no, kind, state, ref_event_id, link_kind, link_value, actor, body, created_at
        )
        SELECT event_id, registrar_id, phase_no, kind, state, ref_event_id, link_kind, link_value, actor, body, created_at
        FROM registrar_events__pre_entry_transition
      `);
      const maxEventId =
        db
          .query<
            { max_event_id: number | null },
            []
          >("SELECT MAX(event_id) AS max_event_id FROM registrar_events")
          .get()?.max_event_id ?? 0;
      const restoredSequence = Math.max(oldSequence, maxEventId);
      if (restoredSequence > 0) {
        db.run("DELETE FROM sqlite_sequence WHERE name = 'registrar_events'");
        db.run("INSERT INTO sqlite_sequence(name, seq) VALUES ('registrar_events', ?)", [
          restoredSequence,
        ]);
      }
      db.run("DROP TABLE registrar_events__pre_entry_transition");
      db.run(
        "CREATE INDEX IF NOT EXISTS registrar_events_by_entry ON registrar_events(registrar_id, created_at)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS registrar_events_open_state ON registrar_events(registrar_id, kind, state)",
      );
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
  } finally {
    db.run(`PRAGMA foreign_keys = ${restoreForeignKeys}`);
  }
}

export function runStartupZombieSweep(db: Database): void {
  const now = Date.now();
  db.prepare(
    `UPDATE dream_cycles SET outcome='crashed', bail_reason='daemon_respawn', ended_at=? WHERE outcome='running'`,
  ).run(now);
  releaseT1RollupClaims(db, { terminalOutcomes: ["crashed"] });
}

export function releaseT1RollupClaims(db: Database, opts: ReleaseT1RollupClaimsOpts): number {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  const outcomes = (opts.terminalOutcomes ?? []).filter((outcome) => outcome.trim().length > 0);
  if (outcomes.length > 0) {
    clauses.push(
      `claimed_by_cycle IN (
         SELECT cycle_id FROM dream_cycles WHERE outcome IN (${outcomes.map(() => "?").join(",")})
       )`,
    );
    params.push(...outcomes);
  }

  if (opts.staleBeforeMs !== undefined && Number.isFinite(opts.staleBeforeMs)) {
    clauses.push("claimed_at <= ?");
    params.push(opts.staleBeforeMs);
  }

  const cycleIds = (opts.cycleIds ?? []).filter((cycleId) => cycleId.trim().length > 0);
  if (cycleIds.length > 0) {
    clauses.push(`claimed_by_cycle IN (${cycleIds.map(() => "?").join(",")})`);
    params.push(...cycleIds);
  }

  if (clauses.length === 0) {
    return 0;
  }

  const result = db
    .prepare(
      `UPDATE t1_rollups
          SET claimed_at=NULL, claimed_by_cycle=NULL
        WHERE claimed_at IS NOT NULL
          AND (${clauses.join(" OR ")})`,
    )
    .run(...params);
  return result.changes;
}

function ensureNullableMaestroSessionChainHandoffId(db: Database): void {
  const columns = db
    .query<{ name: string; notnull: number }, []>(`PRAGMA table_info('maestro_sessions')`)
    .all();
  const chainHandoffCol = columns.find((column) => column.name === "chain_handoff_id");
  if (!chainHandoffCol || chainHandoffCol.notnull === 0) {
    return;
  }

  db.run(`ALTER TABLE maestro_sessions RENAME TO maestro_sessions__legacy_notnull_chain`);
  db.run(`
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
  db.run(`
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
  db.run(`DROP TABLE maestro_sessions__legacy_notnull_chain`);
  db.run(
    `CREATE INDEX IF NOT EXISTS maestro_sessions_chain_handoff_id ON maestro_sessions(chain_handoff_id);`,
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS maestro_sessions_terminated_at ON maestro_sessions(terminated_at);`,
  );
}
