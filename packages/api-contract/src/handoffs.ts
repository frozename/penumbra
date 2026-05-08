import { z } from 'zod';

export const HandoffStatusSchema = z.enum([
  'pending',
  'approved',
  'redirected',
  'rejected',
  'dispatched',
  'completed',
  'failed',
  'expired',
]);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

const NumericBoolean = z.preprocess(
  (v) => (v === 1 ? true : v === 0 ? false : v),
  z.boolean(),
);

export const HandoffRowSchema = z.object({
  handoff_id: z.string(),
  ts: z.string(),
  project_id: z.string().nullable(),
  conversation_id: z.string(),
  from_agent: z.string(),
  to_agent: z.string(),
  to_role: z.string().nullable(),
  message: z.string(),
  status: HandoffStatusSchema,
  resolved_by: z.string().nullable(),
  resolved_at: z.string().nullable(),
  redirected_to: z.string().nullable(),
  resolution_reason: z.string().nullable(),
  triggered_by_event_id: z.string().nullable(),
  chain_max_hops: z.number().int().nullable(),
  chain_trust_mode: z.enum(['all', 'config']).nullable(),
  chain_task_type: z.string().nullable(),
  use_worktree: NumericBoolean.nullable(),
  open_pr_on_review: NumericBoolean.nullable().optional(),
  branch_base: z.string().nullable().optional(),
  error_message: z.string().nullable(),
  cancel_requested_at: z.string().nullable(),
  worker_id: z.string().nullable(),
  parent_handoff_id: z.string().nullable(),
}).loose();
export type HandoffRow = z.infer<typeof HandoffRowSchema>;

export const HandoffsListQuerySchema = z.object({
  conversation_id: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  since: z.string().datetime().optional(),
}).strict();

export const HandoffsListResponseSchema = z.object({
  handoffs: z.array(HandoffRowSchema),
});

export const HandoffsCompletedSinceResponseSchema = z.object({
  done: z.number().int().nonnegative(),
});

export const HandoffsLatestResponseSchema = z.object({
  handoff: HandoffRowSchema,
});
