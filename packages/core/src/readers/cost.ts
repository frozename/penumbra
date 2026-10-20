import type { Database } from "bun:sqlite";

import {
  type PressureWindow,
  type PressureWindowStatus,
  readSubscriptionPressureWindows,
} from "./subscription-pressure.js";

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
  by_provider: {
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
  }[];
  by_provider_model: {
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
  }[];
  window: { from: string; to: string };
}

export interface SubscriptionPressureRow {
  status: PressureWindowStatus;
  window_label: string;
  used_pct: number;
  observed_at: string;
  source_kind: string;
  resets_at: number | null;
}

export type SubscriptionPressureSnapshot = PressureWindow;

interface RecentSubscriptionPressureInput {
  since: string;
  now?: () => Date;
  projectId?: string | null;
}

export function readRecentSubscriptionPressureSnapshots(
  db: Database,
  input: RecentSubscriptionPressureInput,
): SubscriptionPressureSnapshot[] {
  return readSubscriptionPressureWindows(db, input).windows;
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
    model === null || model === undefined
      ? snapshots
      : snapshots.filter((snapshot) => snapshot.model === model);
  const latestByWindow = new Map<string, SubscriptionPressureSnapshot>();
  for (const snapshot of filtered) {
    const prev = latestByWindow.get(snapshot.window_label);
    if (!prev) {
      latestByWindow.set(snapshot.window_label, snapshot);
    }
  }
  return [...latestByWindow.values()].map((snapshot) => ({
    status: snapshot.status,
    window_label: snapshot.window_label,
    used_pct: snapshot.used_pct,
    observed_at: snapshot.observed_at,
    source_kind: snapshot.source_kind,
    resets_at: snapshot.resets_at,
  }));
}

interface PerHandoffModelRow {
  handoff_key: string;
  provider: string | null;
  model: string | null;
  handoff_cost_usd: number | null;
  handoff_cost_usd_billed: number | null;
  handoff_cost_usd_synth: number | null;
  handoff_tokens: number | null;
  handoff_input_tokens: number | null;
  handoff_tokens_cache_read: number | null;
  handoff_tokens_cache_write: number | null;
}

interface PerHandoffProviderRow {
  provider: string | null;
  handoff_cost_usd: number | null;
  handoff_cost_usd_billed: number | null;
  handoff_cost_usd_synth: number | null;
  handoff_tokens: number | null;
  handoff_input_tokens: number;
  handoff_tokens_cache_read: number;
  handoff_tokens_cache_write: number;
}

interface ProviderAgg {
  provider: string | null;
  cost_usd_sum: number;
  cost_usd_billed_sum: number;
  cost_usd_synth_sum: number;
  has_cost: boolean;
  has_cost_billed: boolean;
  has_cost_synth: boolean;
  tokens_used: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  input_tokens: number;
  handoff_count: number;
}

interface ProviderModelAgg extends ProviderAgg {
  model: string | null;
}

const NULL_KEY = "NULL";

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

function cacheReadPct(read: number, input: number): number | null {
  return read + input > 0 ? read / (read + input) : null;
}

function compareCostDesc(a: ProviderAgg, b: ProviderAgg): number {
  const aNull = !a.has_cost;
  const bNull = !b.has_cost;
  if (aNull !== bNull) return aNull ? 1 : -1;
  const aCost = a.has_cost ? a.cost_usd_sum : 0;
  const bCost = b.has_cost ? b.cost_usd_sum : 0;
  if (aCost !== bCost) return bCost - aCost;
  return b.tokens_used - a.tokens_used;
}

function emptyProviderAgg(provider: string | null): ProviderAgg {
  return {
    provider,
    cost_usd_sum: 0,
    cost_usd_billed_sum: 0,
    cost_usd_synth_sum: 0,
    has_cost: false,
    has_cost_billed: false,
    has_cost_synth: false,
    tokens_used: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    input_tokens: 0,
    handoff_count: 0,
  };
}

function fetchPerHandoffModelRows(
  db: Database,
  since: string,
  projectId: string | null,
): (PerHandoffModelRow & { handoff_key: string })[] {
  return db
    .prepare(
      `
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
  `,
    )
    .all(since, projectId, projectId) as (PerHandoffModelRow & { handoff_key: string })[];
}

function mergePerHandoffProvider(
  rows: readonly (PerHandoffModelRow & { handoff_key: string })[],
): Map<string, PerHandoffProviderRow> {
  const out = new Map<string, PerHandoffProviderRow>();
  for (const row of rows) {
    const key = `${row.handoff_key}\u0000${row.provider ?? NULL_KEY}`;
    const existing = out.get(key);
    if (!existing) {
      out.set(key, {
        provider: row.provider,
        handoff_cost_usd: row.handoff_cost_usd,
        handoff_cost_usd_billed: row.handoff_cost_usd_billed,
        handoff_cost_usd_synth: row.handoff_cost_usd_synth,
        handoff_tokens: row.handoff_tokens,
        handoff_input_tokens: row.handoff_input_tokens ?? 0,
        handoff_tokens_cache_read: row.handoff_tokens_cache_read ?? 0,
        handoff_tokens_cache_write: row.handoff_tokens_cache_write ?? 0,
      });
      continue;
    }
    existing.handoff_cost_usd = maxNullable(existing.handoff_cost_usd, row.handoff_cost_usd);
    existing.handoff_cost_usd_billed = maxNullable(
      existing.handoff_cost_usd_billed,
      row.handoff_cost_usd_billed,
    );
    existing.handoff_cost_usd_synth = maxNullable(
      existing.handoff_cost_usd_synth,
      row.handoff_cost_usd_synth,
    );
    existing.handoff_tokens = maxNullable(existing.handoff_tokens, row.handoff_tokens);
    existing.handoff_input_tokens = Math.max(
      existing.handoff_input_tokens,
      row.handoff_input_tokens ?? 0,
    );
    existing.handoff_tokens_cache_read = Math.max(
      existing.handoff_tokens_cache_read,
      row.handoff_tokens_cache_read ?? 0,
    );
    existing.handoff_tokens_cache_write = Math.max(
      existing.handoff_tokens_cache_write,
      row.handoff_tokens_cache_write ?? 0,
    );
  }
  return out;
}

interface Totals {
  sumCost: number;
  sumCostBilled: number;
  sumCostSynth: number;
  sumTokens: number;
  totalHandoffs: number;
  totalWithCost: number;
  totalWithCostBilled: number;
  totalWithCostSynth: number;
}

function emptyTotals(): Totals {
  return {
    sumCost: 0,
    sumCostBilled: 0,
    sumCostSynth: 0,
    sumTokens: 0,
    totalHandoffs: 0,
    totalWithCost: 0,
    totalWithCostBilled: 0,
    totalWithCostSynth: 0,
  };
}

function tallyHandoffTotals(totals: Totals, v: PerHandoffProviderRow): void {
  totals.totalHandoffs += 1;
  if (v.handoff_cost_usd !== null) {
    totals.totalWithCost += 1;
    totals.sumCost += v.handoff_cost_usd;
  }
  if (v.handoff_cost_usd_billed !== null) {
    totals.totalWithCostBilled += 1;
    totals.sumCostBilled += v.handoff_cost_usd_billed;
  }
  if (v.handoff_cost_usd_synth !== null) {
    totals.sumCostSynth += v.handoff_cost_usd_synth;
    totals.totalWithCostSynth += 1;
  }
  totals.sumTokens += v.handoff_tokens ?? 0;
}

function accumulateProvider(pa: ProviderAgg, v: PerHandoffProviderRow): void {
  pa.handoff_count += 1;
  if (v.handoff_cost_usd !== null) {
    pa.has_cost = true;
    pa.cost_usd_sum += v.handoff_cost_usd;
  }
  if (v.handoff_cost_usd_billed !== null) {
    pa.has_cost_billed = true;
    pa.cost_usd_billed_sum += v.handoff_cost_usd_billed;
  }
  if (v.handoff_cost_usd_synth !== null) {
    pa.has_cost_synth = true;
    pa.cost_usd_synth_sum += v.handoff_cost_usd_synth;
  }
  pa.tokens_used += v.handoff_tokens ?? 0;
  pa.input_tokens += v.handoff_input_tokens;
  pa.tokens_cache_read += v.handoff_tokens_cache_read;
  pa.tokens_cache_write += v.handoff_tokens_cache_write;
}

function accumulateProviderModel(pma: ProviderModelAgg, row: PerHandoffModelRow): void {
  pma.handoff_count += 1;
  if (row.handoff_cost_usd !== null) {
    pma.has_cost = true;
    pma.cost_usd_sum += row.handoff_cost_usd;
  }
  if (row.handoff_cost_usd_billed !== null) {
    pma.has_cost_billed = true;
    pma.cost_usd_billed_sum += row.handoff_cost_usd_billed;
  }
  if (row.handoff_cost_usd_synth !== null) {
    pma.has_cost_synth = true;
    pma.cost_usd_synth_sum += row.handoff_cost_usd_synth;
  }
  pma.tokens_used += row.handoff_tokens ?? 0;
  pma.input_tokens += row.handoff_input_tokens ?? 0;
  pma.tokens_cache_read += row.handoff_tokens_cache_read ?? 0;
  pma.tokens_cache_write += row.handoff_tokens_cache_write ?? 0;
}

function aggregatePerProvider(perHandoffProvider: ReadonlyMap<string, PerHandoffProviderRow>): {
  byProvider: Map<string, ProviderAgg>;
  totals: Totals;
} {
  const byProvider = new Map<string, ProviderAgg>();
  const totals = emptyTotals();
  for (const v of perHandoffProvider.values()) {
    tallyHandoffTotals(totals, v);
    const pKey = v.provider ?? NULL_KEY;
    const pa = byProvider.get(pKey) ?? emptyProviderAgg(v.provider);
    byProvider.set(pKey, pa);
    accumulateProvider(pa, v);
  }
  return { byProvider, totals };
}

function aggregatePerProviderModel(
  rows: readonly PerHandoffModelRow[],
): Map<string, ProviderModelAgg> {
  const out = new Map<string, ProviderModelAgg>();
  for (const row of rows) {
    const pmKey = `${row.provider ?? NULL_KEY}\u0000${row.model ?? NULL_KEY}`;
    const pma = out.get(pmKey) ?? { ...emptyProviderAgg(row.provider), model: row.model };
    out.set(pmKey, pma);
    accumulateProviderModel(pma, row);
  }
  return out;
}

function pressureFor(
  pressureByProvider: ReadonlyMap<string, SubscriptionPressureSnapshot[]>,
  provider: string | null,
  model: string | null | undefined,
): SubscriptionPressureRow[] {
  if (provider === null) return [];
  return collectSubscriptionPressure(pressureByProvider.get(provider) ?? [], model);
}

export function recentCostWithPressure(
  db: Database,
  input: RecentCostInput,
  now: () => Date,
): {
  recent: RecentCostOutput;
  pressureByProvider: Map<string, SubscriptionPressureSnapshot[]>;
} {
  const nowDate = now();
  const since = input.since
    ? new Date(input.since).toISOString()
    : new Date(nowDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const window = { from: since, to: nowDate.toISOString() };
  const projectId = input.projectId ?? null;
  const pressureByProvider = indexSubscriptionPressureByProvider(
    readRecentSubscriptionPressureSnapshots(db, { since, projectId, now: () => nowDate }),
  );

  const perHandoffModelRows = fetchPerHandoffModelRows(db, since, projectId);
  const perHandoffProvider = mergePerHandoffProvider(perHandoffModelRows);
  const { byProvider, totals } = aggregatePerProvider(perHandoffProvider);
  const byProviderModel = aggregatePerProviderModel(perHandoffModelRows);

  const byProviderSorted = [...byProvider.values()].sort(compareCostDesc);
  const byProviderModelSorted = [...byProviderModel.values()].sort(compareCostDesc);

  const recent: RecentCostOutput = {
    total_cost_usd: totals.totalWithCost > 0 ? totals.sumCost : null,
    total_cost_usd_billed: totals.totalWithCostBilled > 0 ? totals.sumCostBilled : null,
    total_cost_usd_synth: totals.totalWithCostSynth > 0 ? totals.sumCostSynth : null,
    total_tokens_used: totals.sumTokens,
    handoff_count: totals.totalHandoffs,
    by_provider: byProviderSorted.map((r) => ({
      provider: r.provider,
      cost_usd: r.has_cost ? r.cost_usd_sum : null,
      cost_usd_billed: r.has_cost_billed ? r.cost_usd_billed_sum : null,
      cost_usd_synth: r.has_cost_synth ? r.cost_usd_synth_sum : null,
      tokens_used: r.tokens_used,
      tokens_cache_read: r.tokens_cache_read,
      tokens_cache_write: r.tokens_cache_write,
      cache_read_pct: cacheReadPct(r.tokens_cache_read, r.input_tokens),
      handoff_count: r.handoff_count,
      subscription_pressure: pressureFor(pressureByProvider, r.provider, null),
    })),
    by_provider_model: byProviderModelSorted.map((r) => ({
      provider: r.provider,
      model: r.model,
      cost_usd: r.has_cost ? r.cost_usd_sum : null,
      cost_usd_billed: r.has_cost_billed ? r.cost_usd_billed_sum : null,
      cost_usd_synth: r.has_cost_synth ? r.cost_usd_synth_sum : null,
      tokens_used: r.tokens_used,
      tokens_cache_read: r.tokens_cache_read,
      tokens_cache_write: r.tokens_cache_write,
      cache_read_pct: cacheReadPct(r.tokens_cache_read, r.input_tokens),
      handoff_count: r.handoff_count,
      subscription_pressure: pressureFor(pressureByProvider, r.provider, r.model),
    })),
    window,
  };
  return { recent, pressureByProvider };
}

export function recentCost(
  db: Database,
  input: RecentCostInput,
  now: () => Date,
): RecentCostOutput {
  return recentCostWithPressure(db, input, now).recent;
}
