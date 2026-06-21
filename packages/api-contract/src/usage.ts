import { z } from "zod";

export const UsageRecentQuerySchema = z
  .object({
    since: z.iso.datetime().optional(),
    project_id: z.string().min(1).nullable().optional(),
  })
  .strict();

export const UsageQuotaQuerySchema = z
  .object({
    since: z.iso.datetime().optional(),
    window: z.enum(["24h", "5h"]).optional(),
  })
  .strict();

export const UsageSubscriptionPressureQuerySchema = z
  .object({
    provider: z.string().min(1).optional(),
    stale_after_seconds: z.coerce.number().int().positive().max(86400).optional(),
  })
  .strict();

// Reader output shapes evolve with cost ledger work; consume loosely.
export const UsageRecentResponseSchema = z.object({}).loose();
export const UsageQuotaResponseSchema = z.object({}).loose();
export const UsageSubscriptionPressureResponseSchema = z.object({}).loose();
