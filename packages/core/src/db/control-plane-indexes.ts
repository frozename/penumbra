import type { Database } from "bun:sqlite";

// Keep the null predicates in the keys so SQLite can cover these scans without fetching wide rows.
export const CONTROL_PLANE_INDEX_SQL = [
  `CREATE INDEX IF NOT EXISTS t1_promotion_eligible_lookup
     ON t1_rollups(t2_promoted_at,promotion_filtered_at,n_events,failed_promotion_attempts,ended_at,started_at,rollup_id)
     WHERE t2_promoted_at IS NULL AND promotion_filtered_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS t1_promotion_claim_lookup
     ON t1_rollups(t2_promoted_at,promotion_filtered_at,claimed_at,promotion_unusable_excerpt_at,promotion_retry_exhausted_at,started_at,promotion_retry_after,first_prompt_excerpt,user_id,rollup_id,project_id,promotion_retry_count)
     WHERE t2_promoted_at IS NULL AND claimed_at IS NULL AND promotion_filtered_at IS NULL
       AND promotion_unusable_excerpt_at IS NULL AND promotion_retry_exhausted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_dream_actions_phase_status ON dream_actions(phase,status)`,
] as const;

// Built only in an operator maintenance window under a deadline (docs/operations/schema-49-cutover.md):
// dispatch_events is the largest table, and applySchema would hold its write transaction for the
// whole unbounded build. The idle check is already served by idx_dispatch_events_ts without it.
export const DEFERRED_ACTIVITY_INDEX_NAME = "idx_dispatch_events_activity_end_ts";
export const DEFERRED_ACTIVITY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${DEFERRED_ACTIVITY_INDEX_NAME} ON dispatch_events(ts)
     WHERE kind IN ('dispatch.end','long_lived.tick.end')`;

export function ensureControlPlaneIndexes(db: Database): void {
  for (const sql of CONTROL_PLANE_INDEX_SQL) db.run(sql);
}
