import type { Database } from "bun:sqlite";

export interface RecentCostInput {
  since?: string;
  projectId?: string | null;
}

export interface RecentCostOutput {
  total_cost_usd: number | null;
  total_cost_usd_billed: number | null;
  total_cost_usd_synth: number | null;
  total_tokens_used: number;
  handoff_count: number;
  by_provider: Array<{
    provider: string | null;
    cost_usd: number | null;
    cost_usd_billed: number | null;
    cost_usd_synth: number | null;
    tokens_used: number;
    tokens_cache_read: number;
    tokens_cache_write: number;
    cache_read_pct: number | null;
    handoff_count: number;
    subscription_pressure: SubscriptionPressureRow[];
  }>;
  by_provider_model: Array<{
    provider: string | null;
    model: string | null;
    cost_usd: number | null;
    cost_usd_billed: number | null;
    cost_usd_synth: number | null;
    tokens_used: number;
    tokens_cache_read: number;
    tokens_cache_write: number;
    cache_read_pct: number | null;
    handoff_count: number;
    subscription_pressure: SubscriptionPressureRow[];
  }>;
  window: { from: string; to: string };
}

export interface SubscriptionPressureRow {
  window_label: string;
  used_pct: number;
  observed_at: string;
  source_kind: string;
  resets_at: number | null;
}

export interface SubscriptionPressureSnapshot extends SubscriptionPressureRow {
  provider: string;
  model: string | null;
}

interface RecentSubscriptionPressureInput {
  since: string;
  projectId?: string | null;
}

interface SnapshotQueryRow {
  ts: string;
  provider: string;
  model: string | null;
  payload_json: string;
}

export function readRecentSubscriptionPressureSnapshots(
  db: Database,
  input: RecentSubscriptionPressureInput,
): SubscriptionPressureSnapshot[] {
  const rows = db
    .prepare(
      `
    SELECT ts, provider, model, payload_json
    FROM t0_events
    WHERE event_type = 'rate-limit-snapshot'
      AND ts >= ?
      AND (? IS NULL OR project_id = ?)
      AND provider IS NOT NULL
    ORDER BY ts DESC
  `,
    )
    .all(input.since, input.projectId ?? null, input.projectId ?? null) as SnapshotQueryRow[];

  const latestByGroup = new Map<string, SubscriptionPressureSnapshot>();
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as {
      window_label: string;
      used_pct: number;
      source_kind: string;
      resets_at?: number | null;
    };
    const key = `${row.provider}\u0000${payload.window_label}\u0000${row.model ?? ""}`;
    if (latestByGroup.has(key)) continue;
    latestByGroup.set(key, {
      provider: row.provider,
      model: row.model ?? null,
      window_label: payload.window_label,
      used_pct: payload.used_pct,
      observed_at: row.ts,
      source_kind: payload.source_kind,
      resets_at: payload.resets_at ?? null,
    });
  }
  return [...latestByGroup.values()];
}

export function indexSubscriptionPressureByProvider(
  snapshots: SubscriptionPressureSnapshot[],
): Map<string, SubscriptionPressureSnapshot[]> {
  const byProvider = new Map<string, SubscriptionPressureSnapshot[]>();
  for (const snapshot of snapshots) {
    const current = byProvider.get(snapshot.provider) ?? [];
    current.push(snapshot);
    byProvider.set(snapshot.provider, current);
  }
  return byProvider;
}

export function collectSubscriptionPressure(
  snapshots: SubscriptionPressureSnapshot[],
  model: string | null | undefined,
): SubscriptionPressureRow[] {
  const filtered =
    model == null ? snapshots : snapshots.filter((snapshot) => snapshot.model === model);
  const latestByWindow = new Map<string, SubscriptionPressureSnapshot>();
  for (const snapshot of filtered) {
    const prev = latestByWindow.get(snapshot.window_label);
    if (!prev || snapshot.observed_at > prev.observed_at) {
      latestByWindow.set(snapshot.window_label, snapshot);
    }
  }
  return [...latestByWindow.values()].map((snapshot) => ({
    window_label: snapshot.window_label,
    used_pct: snapshot.used_pct,
    observed_at: snapshot.observed_at,
    source_kind: snapshot.source_kind,
    resets_at: snapshot.resets_at,
  }));
}

export function recentCost(
  db: Database,
  input: RecentCostInput,
  now: () => Date,
): RecentCostOutput {
  const nowDate = now();
  const since = input.since
    ? new Date(input.since).toISOString()
    : new Date(nowDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const window = { from: since, to: nowDate.toISOString() };
  const pressureByProvider = indexSubscriptionPressureByProvider(
    readRecentSubscriptionPressureSnapshots(db, { since, projectId: input.projectId ?? null }),
  );

  const totalsRow = db
    .prepare(
      `
    WITH per_handoff AS (
      SELECT
        COALESCE(json_extract(payload_json, '$.handoff_id'), event_id) AS handoff_key,
        provider,
        MAX(cost_usd) AS handoff_cost_usd,
        MAX(CASE WHEN lane = 'cloud' THEN cost_usd END) AS handoff_cost_usd_billed,
        MAX(CASE WHEN lane = 'cli-subscription' THEN cost_usd END) AS handoff_cost_usd_synth,
        MAX(CAST(json_extract(payload_json, '$.used') AS INTEGER)) AS handoff_tokens,
        MAX(COALESCE(CAST(json_extract(payload_json, '$.tokens_input') AS INTEGER), tokens_in, 0)) AS handoff_input_tokens,
        MAX(COALESCE(CAST(json_extract(payload_json, '$.tokens_cache_read') AS INTEGER), 0)) AS handoff_tokens_cache_read,
        MAX(COALESCE(CAST(json_extract(payload_json, '$.tokens_cache_write') AS INTEGER), 0)) AS handoff_tokens_cache_write
      FROM t0_events
      WHERE event_type = 'usage-update'
        AND ts >= ?
        AND (? IS NULL OR project_id = ?)
      GROUP BY handoff_key, provider
    )
    SELECT
      SUM(handoff_cost_usd) AS sum_cost,
      SUM(handoff_cost_usd_billed) AS sum_cost_billed,
      SUM(handoff_cost_usd_synth) AS sum_cost_synth,
      SUM(handoff_tokens)   AS sum_tokens,
      COUNT(*)              AS n,
      SUM(CASE WHEN handoff_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS n_with_cost,
      SUM(CASE WHEN handoff_cost_usd_billed IS NOT NULL THEN 1 ELSE 0 END) AS n_with_cost_billed,
      SUM(CASE WHEN handoff_cost_usd_synth IS NOT NULL THEN 1 ELSE 0 END) AS n_with_cost_synth
    FROM per_handoff
  `,
    )
    .get(since, input.projectId ?? null, input.projectId ?? null) as
    | {
        sum_cost: number | null;
        sum_cost_billed: number | null;
        sum_cost_synth: number | null;
        sum_tokens: number | null;
        n: number;
        n_with_cost: number | null;
        n_with_cost_billed: number | null;
        n_with_cost_synth: number | null;
      }
    | undefined;

  const byProviderRows = db
    .prepare(
      `
    WITH per_handoff AS (
      SELECT
        COALESCE(json_extract(payload_json, '$.handoff_id'), event_id) AS handoff_key,
        provider,
        MAX(cost_usd) AS handoff_cost_usd,
        MAX(CASE WHEN lane = 'cloud' THEN cost_usd END) AS handoff_cost_usd_billed,
        MAX(CASE WHEN lane = 'cli-subscription' THEN cost_usd END) AS handoff_cost_usd_synth,
        MAX(CAST(json_extract(payload_json, '$.used') AS INTEGER)) AS handoff_tokens,
        MAX(COALESCE(CAST(json_extract(payload_json, '$.tokens_input') AS INTEGER), tokens_in, 0)) AS handoff_input_tokens,
        MAX(COALESCE(CAST(json_extract(payload_json, '$.tokens_cache_read') AS INTEGER), 0)) AS handoff_tokens_cache_read,
        MAX(COALESCE(CAST(json_extract(payload_json, '$.tokens_cache_write') AS INTEGER), 0)) AS handoff_tokens_cache_write
      FROM t0_events
      WHERE event_type = 'usage-update'
        AND ts >= ?
        AND (? IS NULL OR project_id = ?)
      GROUP BY handoff_key, provider
    )
    SELECT
      provider,
      SUM(handoff_cost_usd) AS cost_usd,
      SUM(handoff_cost_usd_billed) AS cost_usd_billed,
      SUM(handoff_cost_usd_synth) AS cost_usd_synth,
      SUM(handoff_tokens)   AS tokens_used,
      SUM(handoff_tokens_cache_read) AS tokens_cache_read,
      SUM(handoff_tokens_cache_write) AS tokens_cache_write,
      CASE
        WHEN SUM(handoff_tokens_cache_read) + SUM(handoff_input_tokens) > 0
          THEN CAST(SUM(handoff_tokens_cache_read) AS REAL) / (SUM(handoff_tokens_cache_read) + SUM(handoff_input_tokens))
        ELSE NULL
      END AS cache_read_pct,
      COUNT(*)              AS handoff_count
    FROM per_handoff
    GROUP BY provider
    ORDER BY (cost_usd IS NULL) ASC, cost_usd DESC, tokens_used DESC
  `,
    )
    .all(since, input.projectId ?? null, input.projectId ?? null) as Array<{
    provider: string | null;
    cost_usd: number | null;
    cost_usd_billed: number | null;
    cost_usd_synth: number | null;
    tokens_used: number | null;
    tokens_cache_read: number | null;
    tokens_cache_write: number | null;
    cache_read_pct: number | null;
    handoff_count: number;
  }>;

  const byProviderModelRows = db
    .prepare(
      `
    WITH per_handoff AS (
      SELECT
        COALESCE(json_extract(payload_json, '$.handoff_id'), event_id) AS handoff_key,
        provider,
        model,
        MAX(cost_usd) AS handoff_cost_usd,
        MAX(CASE WHEN lane = 'cloud' THEN cost_usd END) AS handoff_cost_usd_billed,
        MAX(CASE WHEN lane = 'cli-subscription' THEN cost_usd END) AS handoff_cost_usd_synth,
        MAX(CAST(json_extract(payload_json, '$.used') AS INTEGER)) AS handoff_tokens,
        MAX(COALESCE(CAST(json_extract(payload_json, '$.tokens_input') AS INTEGER), tokens_in, 0)) AS handoff_input_tokens,
        MAX(COALESCE(CAST(json_extract(payload_json, '$.tokens_cache_read') AS INTEGER), 0)) AS handoff_tokens_cache_read,
        MAX(COALESCE(CAST(json_extract(payload_json, '$.tokens_cache_write') AS INTEGER), 0)) AS handoff_tokens_cache_write
      FROM t0_events
      WHERE event_type = 'usage-update'
        AND ts >= ?
        AND (? IS NULL OR project_id = ?)
      GROUP BY handoff_key, provider, model
    )
    SELECT
      provider,
      model,
      SUM(handoff_cost_usd) AS cost_usd,
      SUM(handoff_cost_usd_billed) AS cost_usd_billed,
      SUM(handoff_cost_usd_synth) AS cost_usd_synth,
      SUM(handoff_tokens)   AS tokens_used,
      SUM(handoff_tokens_cache_read) AS tokens_cache_read,
      SUM(handoff_tokens_cache_write) AS tokens_cache_write,
      CASE
        WHEN SUM(handoff_tokens_cache_read) + SUM(handoff_input_tokens) > 0
          THEN CAST(SUM(handoff_tokens_cache_read) AS REAL) / (SUM(handoff_tokens_cache_read) + SUM(handoff_input_tokens))
        ELSE NULL
      END AS cache_read_pct,
      COUNT(*)              AS handoff_count
    FROM per_handoff
    GROUP BY provider, model
    ORDER BY (cost_usd IS NULL) ASC, cost_usd DESC, tokens_used DESC
  `,
    )
    .all(since, input.projectId ?? null, input.projectId ?? null) as Array<{
    provider: string | null;
    model: string | null;
    cost_usd: number | null;
    cost_usd_billed: number | null;
    cost_usd_synth: number | null;
    tokens_used: number | null;
    tokens_cache_read: number | null;
    tokens_cache_write: number | null;
    cache_read_pct: number | null;
    handoff_count: number;
  }>;

  const total_cost_usd = (totalsRow?.n_with_cost ?? 0) > 0 ? (totalsRow?.sum_cost ?? 0) : null;
  const total_cost_usd_billed =
    (totalsRow?.n_with_cost_billed ?? 0) > 0 ? (totalsRow?.sum_cost_billed ?? 0) : null;
  const total_cost_usd_synth =
    (totalsRow?.n_with_cost_synth ?? 0) > 0 ? (totalsRow?.sum_cost_synth ?? 0) : null;
  return {
    total_cost_usd,
    total_cost_usd_billed,
    total_cost_usd_synth,
    total_tokens_used: totalsRow?.sum_tokens ?? 0,
    handoff_count: totalsRow?.n ?? 0,
    by_provider: byProviderRows.map((r) => ({
      provider: r.provider,
      cost_usd: r.cost_usd,
      cost_usd_billed: r.cost_usd_billed,
      cost_usd_synth: r.cost_usd_synth,
      tokens_used: r.tokens_used ?? 0,
      tokens_cache_read: r.tokens_cache_read ?? 0,
      tokens_cache_write: r.tokens_cache_write ?? 0,
      cache_read_pct: r.cache_read_pct,
      handoff_count: r.handoff_count,
      subscription_pressure:
        r.provider == null
          ? []
          : collectSubscriptionPressure(pressureByProvider.get(r.provider) ?? [], null),
    })),
    by_provider_model: byProviderModelRows.map((r) => ({
      provider: r.provider,
      model: r.model,
      cost_usd: r.cost_usd,
      cost_usd_billed: r.cost_usd_billed,
      cost_usd_synth: r.cost_usd_synth,
      tokens_used: r.tokens_used ?? 0,
      tokens_cache_read: r.tokens_cache_read ?? 0,
      tokens_cache_write: r.tokens_cache_write ?? 0,
      cache_read_pct: r.cache_read_pct,
      handoff_count: r.handoff_count,
      subscription_pressure:
        r.provider == null
          ? []
          : collectSubscriptionPressure(pressureByProvider.get(r.provider) ?? [], r.model),
    })),
    window,
  };
}
