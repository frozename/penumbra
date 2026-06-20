import type { Database } from "bun:sqlite";
import { DEFAULT_AGENT_KIND, type AgentPerformanceRow } from "../schemas/agent-performance.js";

export class AgentPerformanceWriter {
  private readonly upsertStmt;

  constructor(private readonly db: Database) {
    this.upsertStmt = this.db.prepare(`
      INSERT INTO agent_performance (
        performance_id, ts, handoff_id, conversation_id, project_id, agent_name,
        task_type, outcome, gate_outcome, rounds, smoke_pass, reviewer_findings, maestro_score,
        cost_usd, tokens_used, latency_ms, exec_ms, framework_overhead_ms, source, notes,
        reliability_status, failure_class, artifact_present, verification_present,
        maestro_takeover_required, empty_response, worktree_changed, reconcile_status,
        environment_failure, trust_score, agent_kind, metadata_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT(handoff_id) DO UPDATE SET
        performance_id=excluded.performance_id,
        ts=excluded.ts,
        conversation_id=excluded.conversation_id,
        project_id=excluded.project_id,
        agent_name=excluded.agent_name,
        task_type=excluded.task_type,
        outcome=excluded.outcome,
        rounds=excluded.rounds,
        smoke_pass=excluded.smoke_pass,
        reviewer_findings=excluded.reviewer_findings,
        maestro_score=excluded.maestro_score,
        cost_usd=excluded.cost_usd,
        tokens_used=excluded.tokens_used,
        latency_ms=excluded.latency_ms,
        exec_ms=excluded.exec_ms,
        framework_overhead_ms=excluded.framework_overhead_ms,
        source=excluded.source,
        notes=excluded.notes,
        reliability_status=COALESCE(excluded.reliability_status, reliability_status),
        failure_class=COALESCE(excluded.failure_class, failure_class),
        artifact_present=excluded.artifact_present,
        verification_present=excluded.verification_present,
        maestro_takeover_required=COALESCE(excluded.maestro_takeover_required, maestro_takeover_required),
        empty_response=excluded.empty_response,
        worktree_changed=excluded.worktree_changed,
        reconcile_status=excluded.reconcile_status,
        environment_failure=excluded.environment_failure,
        trust_score=excluded.trust_score,
        agent_kind=excluded.agent_kind,
        metadata_json=excluded.metadata_json
    `);
  }

  upsert(row: AgentPerformanceRow): AgentPerformanceRow {
    this.upsertStmt.run(
      row.performance_id,
      row.ts,
      row.handoff_id,
      row.conversation_id,
      row.project_id,
      row.agent_name,
      row.task_type,
      row.outcome,
      row.gate_outcome ?? null,
      row.rounds,
      row.smoke_pass,
      row.reviewer_findings,
      row.maestro_score,
      row.cost_usd,
      row.tokens_used,
      row.latency_ms,
      row.exec_ms ?? null,
      row.framework_overhead_ms ?? null,
      row.source,
      row.notes,
      row.reliability_status ?? null,
      row.failure_class ?? null,
      row.artifact_present ?? null,
      row.verification_present ?? null,
      row.maestro_takeover_required ?? null,
      row.empty_response ?? null,
      row.worktree_changed ?? null,
      row.reconcile_status ?? null,
      row.environment_failure ?? null,
      row.trust_score ?? null,
      row.agent_kind ?? DEFAULT_AGENT_KIND,
      row.metadata_json,
    );
    return row;
  }
}
