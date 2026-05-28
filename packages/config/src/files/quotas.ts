import { z } from "zod";

/**
 * Schema for the quota-focused config split file.
 * Covers provider quotas and pressure-cap thresholds.
 * Mirrors the legacy provider quota behavior and transforms.
 */

const PressureCapWindowSchema = z.union([
  z
    .number()
    .int()
    .min(1)
    .max(100)
    .transform((refuse) => ({ warn: null as number | null, refuse })),
  z
    .object({
      warn: z.number().int().min(1).max(100).nullable().optional(),
      refuse: z.number().int().min(1).max(100),
    })
    .superRefine((data, ctx) => {
      if (data.warn !== null && data.warn !== undefined && data.warn >= data.refuse) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["warn"],
          message: "warn must be < refuse",
        });
      }
    })
    .transform((value) => ({
      warn: value.warn ?? null,
      refuse: value.refuse,
    })),
]);

export const ProviderQuotaConfigSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1).optional(),
  quota_usd_per_24h: z.number().positive().optional(),
  quota_tokens_per_24h: z.number().int().positive().optional(),
  quota_tokens_per_5h: z.number().int().positive().optional(),
  pressure_caps: z.record(z.string().min(1), PressureCapWindowSchema).optional(),
});
export type ProviderQuotaConfig = z.infer<typeof ProviderQuotaConfigSchema>;

export const QuotasConfigSchema = z
  .object({
    providers: z.array(ProviderQuotaConfigSchema).default([]),
  })
  .strict();
export type QuotasConfig = z.infer<typeof QuotasConfigSchema>;
