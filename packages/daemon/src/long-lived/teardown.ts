import type { Database } from "bun:sqlite";

import { AgentPerformanceWriter, createLogger } from "@penumbra/core";

export type TickOutcome = "success" | "failed" | "bound_exceeded";

export interface TeardownInput {
  tick_id: string;
  agent_id: string;
  outcome: TickOutcome;
  cost_cents?: number;
  error?: string;
  now: number;
}

const logger = createLogger({ component: "daemon:long-lived:teardown" });

function isTransientRateLimit(error?: string): boolean {
  if (!error) return false;
  return (
    /rate.?limit/i.test(error) ||
    /hit your limit/i.test(error) ||
    /\bquota\b/i.test(error) ||
    /\b429\b/.test(error) ||
    error.includes("-32603") ||
    /resets?\s+\d+\s*(?:am|pm)/i.test(error)
  );
}

export function handleTickTeardown(db: Database, input: TeardownInput): void {
  db.transaction(() => {
    new AgentPerformanceWriter(db).upsert({
      performance_id: `long-lived-${input.tick_id}`,
      ts: new Date(input.now).toISOString(),
      handoff_id: input.tick_id,
      conversation_id: null,
      project_id: null,
      agent_name: input.agent_id,
      task_type: "health_check",
      outcome: input.outcome === "success" ? "merged" : "failed",
      gate_outcome: input.outcome === "success" ? "skipped" : null,
      rounds: null,
      smoke_pass: null,
      reviewer_findings: null,
      maestro_score: null,
      cost_usd: input.cost_cents !== undefined ? input.cost_cents / 100 : null,
      tokens_used: null,
      latency_ms: null,
      source: "manual_seed",
      notes: input.error ?? null,
      agent_kind: "long_lived",
      metadata_json: "{}",
    });
    db.query(
      `UPDATE long_lived_ticks
        SET outcome = ?, cost_cents = ?, error_summary = ?, completed_at = ?
        WHERE id = ?`,
    ).run(input.outcome, input.cost_cents ?? null, input.error ?? null, input.now, input.tick_id);

    if (input.outcome === "success") {
      db.query(
        `UPDATE long_lived_agents
          SET consecutive_failures = 0,
              last_tick_outcome = ?,
              last_tick_completed_at = ?,
              updated_at = ?
          WHERE id = ?`,
      ).run(input.outcome, input.now, input.now, input.agent_id);
      return;
    }

    const row = db
      .query<
        {
          consecutive_failures: number;
          circuit_breaker_threshold: number;
          status: string;
        },
        [string]
      >(
        "SELECT consecutive_failures, circuit_breaker_threshold, status FROM long_lived_agents WHERE id = ?",
      )
      .get(input.agent_id);
    if (!row) return;

    if (isTransientRateLimit(input.error)) {
      db.query(
        `UPDATE long_lived_agents
          SET last_tick_outcome = ?,
              last_tick_completed_at = ?,
              updated_at = ?
          WHERE id = ?`,
      ).run(input.outcome, input.now, input.now, input.agent_id);
      return;
    }

    const nextFailures = row.consecutive_failures + 1;
    const shouldTrip = row.status === "active" && nextFailures >= row.circuit_breaker_threshold;
    const degradedReason = shouldTrip
      ? `${input.outcome}: ${input.error ?? "(no error message)"}`
      : null;

    db.query(
      `UPDATE long_lived_agents
        SET consecutive_failures = ?,
            last_tick_outcome = ?,
            last_tick_completed_at = ?,
            status = ?,
            degraded_reason = ?,
            updated_at = ?
        WHERE id = ?`,
    ).run(
      nextFailures,
      input.outcome,
      input.now,
      shouldTrip ? "degraded" : row.status,
      degradedReason,
      input.now,
      input.agent_id,
    );

    if (shouldTrip) {
      logger.warn(
        { agent_id: input.agent_id, threshold: row.circuit_breaker_threshold },
        "long-lived circuit breaker opened",
      );
    }
  })();
}
