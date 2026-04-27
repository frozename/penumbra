import { z } from 'zod';
import { SafeProjectIdSchema } from './project-id.js';

export const T1RollupSchema = z.object({
  rollup_id: z.string(),
  project_id: SafeProjectIdSchema.nullable(),
  user_id: z.string(),
  session_id: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  n_events: z.number().int().nonnegative(),
  lane_breakdown: z.record(z.string(), z.number()),
  provider_breakdown: z.record(z.string(), z.number()),
  cost_usd_total: z.number().nullable(),
  tokens_in_total: z.number().int().nullable(),
  tokens_out_total: z.number().int().nullable(),
  first_prompt_excerpt: z.string().nullable(),
  last_response_excerpt: z.string().nullable(),
  tool_calls_summary: z.string().nullable(),
  source_event_ids: z.array(z.string()),
  t2_promoted_at: z.string().nullable(),
  failed_promotion_attempts: z.number().int().nonnegative().default(0),
});

export type T1RollupRow = z.infer<typeof T1RollupSchema>;
