import type { Database } from 'bun:sqlite';
import type { AgentPerformanceRow } from '../schemas/agent-performance.js';

export class AgentPerformanceWriter {
  private readonly upsertStmt;

  constructor(private readonly db: Database) {
    this.upsertStmt = this.db.prepare(`
      INSERT INTO agent_performance (
        performance_id, ts, handoff_id, conversation_id, project_id, agent_name,
        task_type, outcome, rounds, smoke_pass, reviewer_findings, maestro_score,
        cost_usd, tokens_used, latency_ms, source, notes, metadata_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
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
        source=excluded.source,
        notes=excluded.notes,
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
      row.rounds,
      row.smoke_pass,
      row.reviewer_findings,
      row.maestro_score,
      row.cost_usd,
      row.tokens_used,
      row.latency_ms,
      row.source,
      row.notes,
      row.metadata_json,
    );
    return row;
  }
}
