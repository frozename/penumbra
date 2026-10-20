import type { QuotaStatusOutput, Services } from "@penumbra/core";
import type { Database } from "bun:sqlite";

import { quotaStatus, readSubscriptionPressure, recentCost } from "@penumbra/core";
import { z } from "zod";

import { json } from "./_helpers.js";
const RecentInputSchema = z.object({
  since: z.iso.datetime().optional(),
  project_id: z.string().min(1).nullable().optional(),
});

const QuotaInputSchema = z.object({
  since: z.iso.datetime().optional(),
  window: z.enum(["24h", "5h", "7d"]).optional(),
});

const SubscriptionPressureInputSchema = z.object({
  provider: z.string().min(1).optional(),
  stale_after_seconds: z.coerce.number().int().positive().max(86400).optional(),
});

export function usageRecentRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const parsed = RecentInputSchema.safeParse({
    since: url.searchParams.get("since") ?? undefined,
    project_id: url.searchParams.get("project_id") ?? undefined,
  });
  if (!parsed.success) {
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  }
  const result = recentCost(services.db, parsed.data, services.clock);
  return json(result);
}

// The usage-poller's synth readers and per-worker schedulers hit this route
// every ~60 s; a TTL of 2x the default poll interval collapses fixed-key
// repeats (anchored windows, no-arg calls) while sliding `since` values still
// miss and stay fresh. Keyed on the exact (window, since) pair and the
// providerQuotas array identity so a config reload re-reads immediately.
const QUOTA_STATUS_CACHE_TTL_MS = 120_000;
const QUOTA_STATUS_CACHE_MAX_ENTRIES = 256;

interface QuotaStatusCacheEntry {
  expiresAtMs: number;
  quotas: Services["providerQuotas"];
  body: QuotaStatusOutput;
}

const quotaStatusCache = new WeakMap<Database, Map<string, QuotaStatusCacheEntry>>();

export function usageQuotaStatusRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const parsed = QuotaInputSchema.safeParse({
    since: url.searchParams.get("since") ?? undefined,
    window: url.searchParams.get("window") ?? undefined,
  });
  if (!parsed.success) {
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  }
  const nowMs = services.clock().getTime();
  const key = `${parsed.data.window ?? ""}\u0000${parsed.data.since ?? ""}`;
  let cache = quotaStatusCache.get(services.db);
  const hit = cache?.get(key);
  if (hit && hit.expiresAtMs > nowMs && hit.quotas === services.providerQuotas) {
    return json(hit.body);
  }
  const result = quotaStatus(services.db, services.providerQuotas, parsed.data, services.clock);
  if (!cache) {
    cache = new Map();
    quotaStatusCache.set(services.db, cache);
  }
  for (const [k, entry] of cache) {
    if (entry.expiresAtMs <= nowMs) cache.delete(k);
  }
  if (cache.size >= QUOTA_STATUS_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, {
    expiresAtMs: nowMs + QUOTA_STATUS_CACHE_TTL_MS,
    quotas: services.providerQuotas,
    body: result,
  });
  return json(result);
}

export function usageSubscriptionPressureRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const parsed = SubscriptionPressureInputSchema.safeParse({
    provider: url.searchParams.get("provider") ?? undefined,
    stale_after_seconds: url.searchParams.get("stale_after_seconds") ?? undefined,
  });
  if (!parsed.success) {
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  }
  const result = readSubscriptionPressure(services.db, parsed.data);
  return json(result);
}
