import type { Database } from 'bun:sqlite';

export interface RecentCostInput {
  since?: string;
  projectId?: string | null;
}

export interface RecentCostOutput {
  total_cost_usd: number | null;
  total_tokens_used: number;
  handoff_count: number;
  by_provider: Array<{
    provider: string | null;
    cost_usd: number | null;
    tokens_used: number;
    handoff_count: number;
  }>;
  window: { from: string; to: string };
}

export function recentCost(db: Database, input: RecentCostInput, now: () => Date): RecentCostOutput {
  const nowDate = now();
  const since = input.since ?? new Date(nowDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const window = { from: since, to: nowDate.toISOString() };

  const totalsRow = db.prepare(`
    WITH per_handoff AS (
      SELECT
        COALESCE(json_extract(payload_json, '$.handoff_id'), event_id) AS handoff_key,
        provider,
        MAX(cost_usd) AS handoff_cost_usd,
        MAX(CAST(json_extract(payload_json, '$.used') AS INTEGER)) AS handoff_tokens
      FROM t0_events
      WHERE event_type = 'usage-update'
        AND ts >= ?
        AND (? IS NULL OR project_id = ?)
      GROUP BY handoff_key, provider
    )
    SELECT
      SUM(handoff_cost_usd) AS sum_cost,
      SUM(handoff_tokens)   AS sum_tokens,
      COUNT(*)              AS n,
      SUM(CASE WHEN handoff_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS n_with_cost
    FROM per_handoff
  `).get(since, input.projectId ?? null, input.projectId ?? null) as
    | { sum_cost: number | null; sum_tokens: number | null; n: number; n_with_cost: number | null }
    | undefined;

  const byProviderRows = db.prepare(`
    WITH per_handoff AS (
      SELECT
        COALESCE(json_extract(payload_json, '$.handoff_id'), event_id) AS handoff_key,
        provider,
        MAX(cost_usd) AS handoff_cost_usd,
        MAX(CAST(json_extract(payload_json, '$.used') AS INTEGER)) AS handoff_tokens
      FROM t0_events
      WHERE event_type = 'usage-update'
        AND ts >= ?
        AND (? IS NULL OR project_id = ?)
      GROUP BY handoff_key, provider
    )
    SELECT
      provider,
      SUM(handoff_cost_usd) AS cost_usd,
      SUM(handoff_tokens)   AS tokens_used,
      COUNT(*)              AS handoff_count
    FROM per_handoff
    GROUP BY provider
    ORDER BY (cost_usd IS NULL) ASC, cost_usd DESC, tokens_used DESC
  `).all(since, input.projectId ?? null, input.projectId ?? null) as Array<{
    provider: string | null;
    cost_usd: number | null;
    tokens_used: number | null;
    handoff_count: number;
  }>;

  const total_cost_usd = (totalsRow?.n_with_cost ?? 0) > 0 ? (totalsRow?.sum_cost ?? 0) : null;
  return {
    total_cost_usd,
    total_tokens_used: totalsRow?.sum_tokens ?? 0,
    handoff_count: totalsRow?.n ?? 0,
    by_provider: byProviderRows.map(r => ({
      provider: r.provider,
      cost_usd: r.cost_usd,
      tokens_used: r.tokens_used ?? 0,
      handoff_count: r.handoff_count,
    })),
    window,
  };
}
