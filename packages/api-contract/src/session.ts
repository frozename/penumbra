import { z } from "zod";

const SessionBudgetSchema = z.object({
  current: z.number().int().nonnegative(),
  max_concurrent: z.number().int().nonnegative(),
  soft_warn_pct: z.number(),
});

export const MissionSessionSchema = z
  .object({
    id: z.string(),
    project: z.object({
      id: z.string(),
      name: z.string(),
    }),
    started_at: z.string(),
    dispatched: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    budget: SessionBudgetSchema,
  })
  .strict();

export type MissionSession = z.infer<typeof MissionSessionSchema>;
