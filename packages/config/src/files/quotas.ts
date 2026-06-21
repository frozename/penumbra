import { z } from "zod";
import { CANONICAL_PROVIDER_VALUE_RE } from "../provider-format.js";

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

/**
 * OpenCode-Go exposes no usage API; its rolling/weekly/monthly subscription
 * limits are only readable from the authenticated web console. This block points
 * the opencode-console usage reader at the workspace and the session-cookie file.
 * The cookie itself is NEVER stored inline — only a path to a chmod-600 file
 * (strict schema rejects an inline `cookie` key).
 */
export const OpenCodeConsoleConfigSchema = z
  .object({
    workspace_id: z.string().min(1),
    base_url: z.string().min(1).default("https://opencode.ai"),
    cookie_file: z.string().min(1),
  })
  .strict();
export type OpenCodeConsoleConfig = z.infer<typeof OpenCodeConsoleConfigSchema>;

export const ProviderQuotaConfigSchema = z
  .object({
    name: z.string().min(1).regex(CANONICAL_PROVIDER_VALUE_RE),
    model: z.string().min(1).optional(),
    quota_usd_per_24h: z.number().positive().optional(),
    quota_tokens_per_24h: z.number().int().positive().optional(),
    quota_tokens_per_5h: z.number().int().positive().optional(),
    pressure_caps: z.record(z.string().min(1), PressureCapWindowSchema).optional(),
    opencode_console: OpenCodeConsoleConfigSchema.optional(),
    synthetic_cap: z
      .object({
        max_dispatches: z.number().int().positive(),
        window_seconds: z.number().int().positive(),
      })
      .optional(),
    cost_budget_usd_per_5h: z.number().positive().optional(),
    cost_budget_usd_per_week: z.number().positive().optional(),
    cost_budget_usd_per_month: z.number().positive().optional(),
  })
  .strict();
export type ProviderQuotaConfig = z.infer<typeof ProviderQuotaConfigSchema>;

export const QuotasConfigSchema = z
  .object({
    providers: z.array(ProviderQuotaConfigSchema).default([]),
  })
  .strict()
  .superRefine((data, ctx) => {
    const seen = new Map<string, number>();
    for (let i = 0; i < data.providers.length; i++) {
      const name = data.providers[i]!.name;
      const first = seen.get(name);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["providers", i, "name"],
          message: `duplicate provider name '${name}' (also at providers[${first}]); quota rows are keyed by provider name, so the later entry would silently drop one quota config`,
        });
      } else {
        seen.set(name, i);
      }
    }
  });
export type QuotasConfig = z.infer<typeof QuotasConfigSchema>;
