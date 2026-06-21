import type { Database } from "bun:sqlite";

import {
  collectSubscriptionPressure,
  indexSubscriptionPressureByProvider,
  readRecentSubscriptionPressureSnapshots,
  recentCost,
  type SubscriptionPressureRow,
} from "./cost.js";

export interface ProviderQuota {
  provider: string;
  model?: string;
  quota_usd_per_24h?: number;
  quota_tokens_per_24h?: number;
  quota_tokens_per_5h?: number;
  /** Per-window subscription pressure caps. Consumed by checkPressureCap, not the USD/token quota path. */
  pressure_caps?: Record<string, { warn: number | null; refuse: number }>;
  synthetic_cap?: { max_dispatches: number; window_seconds: number };
}

export interface QuotaStatusInput {
  since?: string;
  /** Which configured ceiling to compare used_tokens against. Defaults to 24h. */
  window?: "24h" | "5h";
}

export interface QuotaStatusProviderRow {
  provider: string;
  model?: string;
  usd_quota_mode: "billed" | "display_only" | "none";
  used_usd: number | null;
  used_usd_synth: number | null;
  quota_usd: number | null;
  remaining_usd: number | null;
  remaining_pct_usd: number | null;
  used_tokens: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cache_read_pct: number | null;
  quota_tokens: number | null;
  remaining_tokens: number | null;
  remaining_pct_tokens: number | null;
  subscription_pressure?: SubscriptionPressureRow[];
}

export interface QuotaStatusOutput {
  window: { from: string; to: string };
  providers: QuotaStatusProviderRow[];
}

interface UsageRow {
  cost_usd: number | null;
  cost_usd_billed: number | null;
  cost_usd_synth: number | null;
  tokens_used: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cache_read_pct: number | null;
}

const EMPTY_USAGE: UsageRow = {
  cost_usd: null,
  cost_usd_billed: null,
  cost_usd_synth: null,
  tokens_used: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  cache_read_pct: null,
};

function pctOf(numer: number | null, denom: number | null): number | null {
  if (numer === null || denom === null || denom <= 0) return null;
  return Math.round((numer / denom) * 1000) / 10;
}

function buildQuotaProviderRow(
  p: ProviderQuota,
  usage: UsageRow,
  input: QuotaStatusInput,
  subscription_pressure: SubscriptionPressureRow[],
): QuotaStatusProviderRow {
  const used_usd = p.quota_usd_per_24h !== undefined ? (usage.cost_usd_billed ?? 0) : null;
  const quota_usd = p.quota_usd_per_24h ?? null;
  const remaining_usd =
    used_usd !== null && quota_usd !== null ? Math.max(0, quota_usd - used_usd) : null;
  const used_tokens = usage.tokens_used;
  const quota_tokens =
    input.window === "5h" ? (p.quota_tokens_per_5h ?? null) : (p.quota_tokens_per_24h ?? null);
  const remaining_tokens = quota_tokens !== null ? Math.max(0, quota_tokens - used_tokens) : null;
  const usd_quota_mode: QuotaStatusProviderRow["usd_quota_mode"] =
    p.pressure_caps || p.synthetic_cap ? "display_only" : quota_usd !== null ? "billed" : "none";

  const row: QuotaStatusProviderRow = {
    provider: p.provider,
    usd_quota_mode,
    used_usd,
    used_usd_synth: usage.cost_usd_synth,
    quota_usd,
    remaining_usd,
    remaining_pct_usd: pctOf(remaining_usd, quota_usd),
    used_tokens,
    tokens_cache_read: usage.tokens_cache_read,
    tokens_cache_write: usage.tokens_cache_write,
    cache_read_pct: usage.cache_read_pct,
    quota_tokens,
    remaining_tokens,
    remaining_pct_tokens: pctOf(remaining_tokens, quota_tokens),
  };
  if (subscription_pressure.length > 0) row.subscription_pressure = subscription_pressure;
  if (p.model) row.model = p.model;
  return row;
}

export function quotaStatus(
  db: Database,
  providers: ProviderQuota[],
  input: QuotaStatusInput,
  now: () => Date,
): QuotaStatusOutput {
  const recent = recentCost(db, { since: input.since }, now);
  const pressureByProvider = indexSubscriptionPressureByProvider(
    readRecentSubscriptionPressureSnapshots(db, { since: recent.window.from }),
  );

  const usageByProvider = new Map<
    string,
    {
      cost_usd: number | null;
      cost_usd_billed: number | null;
      cost_usd_synth: number | null;
      tokens_used: number;
      tokens_cache_read: number;
      tokens_cache_write: number;
      cache_read_pct: number | null;
    }
  >();
  for (const row of recent.by_provider) {
    if (row.provider === null) continue;
    usageByProvider.set(row.provider, {
      cost_usd: row.cost_usd,
      cost_usd_billed: row.cost_usd_billed,
      cost_usd_synth: row.cost_usd_synth,
      tokens_used: row.tokens_used,
      tokens_cache_read: row.tokens_cache_read,
      tokens_cache_write: row.tokens_cache_write,
      cache_read_pct: row.cache_read_pct,
    });
  }
  const usageByProviderModel = new Map<
    string,
    {
      cost_usd: number | null;
      cost_usd_billed: number | null;
      cost_usd_synth: number | null;
      tokens_used: number;
      tokens_cache_read: number;
      tokens_cache_write: number;
      cache_read_pct: number | null;
    }
  >();
  for (const row of recent.by_provider_model) {
    if (row.provider === null) continue;
    const k = `${row.provider}\0${row.model ?? ""}`;
    usageByProviderModel.set(k, {
      cost_usd: row.cost_usd,
      cost_usd_billed: row.cost_usd_billed,
      cost_usd_synth: row.cost_usd_synth,
      tokens_used: row.tokens_used,
      tokens_cache_read: row.tokens_cache_read,
      tokens_cache_write: row.tokens_cache_write,
      cache_read_pct: row.cache_read_pct,
    });
  }

  const out: QuotaStatusProviderRow[] = providers.map((p) => {
    const usage = p.model
      ? (usageByProviderModel.get(`${p.provider}\0${p.model}`) ?? EMPTY_USAGE)
      : (usageByProvider.get(p.provider) ?? EMPTY_USAGE);
    const subscription_pressure = collectSubscriptionPressure(
      pressureByProvider.get(p.provider) ?? [],
      p.model,
    );
    return buildQuotaProviderRow(p, usage, input, subscription_pressure);
  });

  return { window: recent.window, providers: out };
}
