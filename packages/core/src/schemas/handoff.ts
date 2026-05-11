import { z } from 'zod';
import { AgentTaskTypeSchema } from './agent-performance.js';
import { SafeProjectIdSchema } from './project-id.js';

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

export const HandoffRowSchema = z.object({
  handoff_id: z.string(),
  ts: z.string(),
  project_id: SafeProjectIdSchema.nullable(),
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
  chain_task_type: AgentTaskTypeSchema.nullable(),
  dispatch_kind: z.enum(['long_lived_tick']).nullable().optional(),
  long_lived_agent_id: z.string().nullable().optional(),
  long_lived_tick_id: z.string().nullable().optional(),
  use_worktree: z.preprocess(
    (v) => (v === 1 ? true : v === 0 ? false : v),
    z.boolean().nullable(),
  ),
  open_pr_on_review: z.preprocess(
    (v) => (v === 1 ? true : v === 0 ? false : v),
    z.boolean().nullable().optional(),
  ),
  branch_base: z.string().nullable().optional(),
  error_message: z.string().nullable(),
  cancel_requested_at: z.string().nullable(),
  worker_id: z.string().nullable(),
  parent_handoff_id: z.string().nullable(),
});
export type HandoffRow = z.infer<typeof HandoffRowSchema>;

export const CreateHandoffRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  to_role: z.string().nullable().optional(),
  message: z.string().min(1),
  conversation_id: z.string().min(1),
  project_id: SafeProjectIdSchema.nullable().optional(),
  triggered_by_event_id: z.string().min(1),
  use_worktree: z.preprocess(
    (v) => (v === 1 ? true : v === 0 ? false : v),
    z.boolean().nullable().optional(),
  ),
  open_pr_on_review: z.preprocess(
    (v) => (v === 1 ? true : v === 0 ? false : v),
    z.boolean().optional(),
  ),
  chain_task_type: AgentTaskTypeSchema.nullable().optional(),
  parent_handoff_id: z.string().min(1).optional(),
  branch_base: z.string().min(1).optional(),
});
export type CreateHandoffRequest = z.infer<typeof CreateHandoffRequestSchema>;

export const ApproveHandoffRequestSchema = z
  .object({
    redirect_to: z.string().min(1).optional(),
    reject: z.boolean().optional(),
    reason: z.string().optional(),
    resolved_by: z.string().min(1).optional(),
  })
  .refine(
    (v) => !(v.redirect_to && v.reject === true),
    { message: 'redirect_to and reject are mutually exclusive' },
  );
export type ApproveHandoffRequest = z.infer<typeof ApproveHandoffRequestSchema>;
