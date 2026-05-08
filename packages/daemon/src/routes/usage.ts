import type { Services } from '@penumbra/core';
import { quotaStatus, recentCost } from '@penumbra/core';
import { readSubscriptionPressure } from '../../../core/src/readers/subscription-pressure.js';
import { z } from 'zod';

const RecentInputSchema = z.object({
  since: z.string().datetime().optional(),
  project_id: z.string().min(1).nullable().optional(),
});

const QuotaInputSchema = z.object({
  since: z.string().datetime().optional(),
});

const SubscriptionPressureInputSchema = z.object({
  provider: z.string().min(1).optional(),
  stale_after_seconds: z.coerce.number().int().positive().max(86400).optional(),
});

export async function usageRecentRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = RecentInputSchema.safeParse({
    since: url.searchParams.get('since') ?? undefined,
    project_id: url.searchParams.get('project_id') ?? undefined,
  });
  if (!parsed.success) {
    return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  }
  const result = recentCost(services.db, parsed.data, services.clock);
  return json(result);
}

export async function usageQuotaStatusRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = QuotaInputSchema.safeParse({
    since: url.searchParams.get('since') ?? undefined,
  });
  if (!parsed.success) {
    return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  }
  const result = quotaStatus(services.db, services.providerQuotas, parsed.data, services.clock);
  return json(result);
}

export async function usageSubscriptionPressureRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = SubscriptionPressureInputSchema.safeParse({
    provider: url.searchParams.get('provider') ?? undefined,
    stale_after_seconds: url.searchParams.get('stale_after_seconds') ?? undefined,
  });
  if (!parsed.success) {
    return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  }
  const result = readSubscriptionPressure(services.db, parsed.data);
  return json(result);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
