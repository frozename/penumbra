import type { Database } from "bun:sqlite";

import {
  type AgentPerformanceRow,
  type AgentPerformanceUpsertOptions,
  DEFAULT_AGENT_KIND,
} from "../schemas/agent-performance.js";
import { mergeAgentPerformance } from "./agent-performance-merge.js";

export class AgentPerformanceWriter {
  private readonly upsertStmt;
  private readonly selectStmt;

  constructor(private readonly db: Database) {
    this.selectStmt = this.db.prepare<AgentPerformanceRow, [string]>(
      "SELECT * FROM agent_performance WHERE handoff_id = ?",
    );
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
        reliability_status=excluded.reliability_status,
        failure_class=excluded.failure_class,
        artifact_present=excluded.artifact_present,
        verification_present=excluded.verification_present,
        maestro_takeover_required=excluded.maestro_takeover_required,
        empty_response=excluded.empty_response,
        worktree_changed=excluded.worktree_changed,
        reconcile_status=excluded.reconcile_status,
        environment_failure=excluded.environment_failure,
        trust_score=excluded.trust_score,
        agent_kind=excluded.agent_kind,
        metadata_json=excluded.metadata_json
    `);
  }

  upsert(row: AgentPerformanceRow, opts: AgentPerformanceUpsertOptions = {}): AgentPerformanceRow {
    this.db
      .transaction(() => {
        const stored = this.selectStmt.get(row.handoff_id);
        const merged = mergeAgentPerformance(stored, row, opts);
        if (merged === stored) {
          return;
        }
        this.upsertStmt.run(
          merged.performance_id,
          merged.ts,
          merged.handoff_id,
          merged.conversation_id,
          merged.project_id,
          merged.agent_name,
          merged.task_type,
          merged.outcome,
          merged.gate_outcome ?? null,
          merged.rounds,
          merged.smoke_pass,
          merged.reviewer_findings,
          merged.maestro_score,
          merged.cost_usd,
          merged.tokens_used,
          merged.latency_ms,
          merged.exec_ms ?? null,
          merged.framework_overhead_ms ?? null,
          merged.source,
          merged.notes,
          merged.reliability_status ?? null,
          merged.failure_class ?? null,
          merged.artifact_present ?? null,
          merged.verification_present ?? null,
          merged.maestro_takeover_required ?? null,
          merged.empty_response ?? null,
          merged.worktree_changed ?? null,
          // reconcile_status is deprecated/dead — always null in production; do not start writing it.
          merged["reconcile_status" as string as keyof typeof merged] ?? null,
          merged.environment_failure ?? null,
          merged.trust_score ?? null,
          merged.agent_kind ?? DEFAULT_AGENT_KIND,
          merged.metadata_json,
        );
      })
      .immediate();
    return row;
  }
}
