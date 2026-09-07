import { z } from "zod";

export const HealthReviewBacklogSchema = z
  .object({
    open_lanes_count: z.number().int().nonnegative(),
    open_boundary_lanes_count: z.number().int().nonnegative(),
    oldest_open_lane_age_ms: z.number().int().nonnegative(),
  })
  .loose();
export type HealthReviewBacklog = z.infer<typeof HealthReviewBacklogSchema>;

export const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    version: z.string().optional(),
    reviewBacklog: HealthReviewBacklogSchema.optional(),
    lagMs: z.number().optional(),
  })
  .loose();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
