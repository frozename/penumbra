import type { Database } from 'bun:sqlite';

export function rollupCostForChain(db: Database, chain_handoff_id: string): number {
  const row = db.query<{ total_cents: number | null }, [string]>(`
    WITH RECURSIVE chain_tree(id) AS (
      SELECT ? AS id
      UNION ALL
      SELECT h.handoff_id
      FROM handoffs h
      JOIN chain_tree ON h.parent_handoff_id = chain_tree.id
    ),
    per_handoff_usage AS (
      SELECT
        json_extract(t.payload_json, '$.handoff_id') AS handoff_id,
        t.provider,
        t.model,
        MAX(t.cost_usd) AS group_cost_usd
      FROM t0_events t
      WHERE t.event_type = 'usage-update'
        AND json_extract(t.payload_json, '$.handoff_id') IN (SELECT id FROM chain_tree)
      GROUP BY handoff_id, t.provider, t.model
    )
    SELECT CAST(ROUND(COALESCE(SUM(group_cost_usd), 0) * 100.0) AS INTEGER) AS total_cents
    FROM per_handoff_usage
    WHERE group_cost_usd IS NOT NULL
  `).get(chain_handoff_id);

  return row?.total_cents ?? 0;
}
