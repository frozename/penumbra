import type { Database } from 'bun:sqlite';
import { recentCost } from './cost.js';

export interface ProviderQuota {
  provider: string;
  model?: string;
  quota_usd_per_24h?: number;
  quota_tokens_per_24h?: number;
  quota_tokens_per_5h?: number;
}

export interface QuotaStatusInput {
  since?: string;
}

export interface QuotaStatusProviderRow {
  provider: string;
  model?: string;
  used_usd: number | null;
  quota_usd: number | null;
  remaining_usd: number | null;
  remaining_pct_usd: number | null;
  used_tokens: number;
  quota_tokens: number | null;
  remaining_tokens: number | null;
  remaining_pct_tokens: number | null;
}

export interface QuotaStatusOutput {
  window: { from: string; to: string };
  providers: QuotaStatusProviderRow[];
}

export function quotaStatus(
  db: Database,
  providers: ProviderQuota[],
  input: QuotaStatusInput,
  now: () => Date,
): QuotaStatusOutput {
  const recent = recentCost(db, { since: input.since }, now);

  const usageByProvider = new Map<string, { cost_usd: number | null; tokens_used: number }>();
  for (const row of recent.by_provider) {
    if (row.provider == null) continue;
    usageByProvider.set(row.provider, { cost_usd: row.cost_usd, tokens_used: row.tokens_used });
  }
  const usageByProviderModel = new Map<string, { cost_usd: number | null; tokens_used: number }>();
  for (const row of recent.by_provider_model) {
    if (row.provider == null) continue;
    const k = `${row.provider}\0${row.model ?? ''}`;
    usageByProviderModel.set(k, { cost_usd: row.cost_usd, tokens_used: row.tokens_used });
  }

  const out: QuotaStatusProviderRow[] = providers.map((p) => {
    const usage = p.model
      ? (usageByProviderModel.get(`${p.provider}\0${p.model}`) ?? { cost_usd: null, tokens_used: 0 })
      : (usageByProvider.get(p.provider) ?? { cost_usd: null, tokens_used: 0 });

    const used_usd = p.quota_usd_per_24h !== undefined ? (usage.cost_usd ?? 0) : null;
    const quota_usd = p.quota_usd_per_24h ?? null;
    const remaining_usd = (used_usd !== null && quota_usd !== null) ? Math.max(0, quota_usd - used_usd) : null;
    const remaining_pct_usd = (remaining_usd !== null && quota_usd !== null && quota_usd > 0)
      ? Math.round((remaining_usd / quota_usd) * 1000) / 10
      : null;

    const used_tokens = usage.tokens_used;
    const quota_tokens = p.quota_tokens_per_24h ?? null;
    const remaining_tokens = quota_tokens !== null ? Math.max(0, quota_tokens - used_tokens) : null;
    const remaining_pct_tokens = (remaining_tokens !== null && quota_tokens !== null && quota_tokens > 0)
      ? Math.round((remaining_tokens / quota_tokens) * 1000) / 10
      : null;

    const row: QuotaStatusProviderRow = {
      provider: p.provider,
      used_usd, quota_usd, remaining_usd, remaining_pct_usd,
      used_tokens, quota_tokens, remaining_tokens, remaining_pct_tokens,
    };
    if (p.model) row.model = p.model;
    return row;
  });

  return { window: recent.window, providers: out };
}
