import type { Services } from "@penumbra/core";

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

export function usageQuotaStatusRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const parsed = QuotaInputSchema.safeParse({
    since: url.searchParams.get("since") ?? undefined,
    window: url.searchParams.get("window") ?? undefined,
  });
  if (!parsed.success) {
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  }
  const result = quotaStatus(services.db, services.providerQuotas, parsed.data, services.clock);
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
