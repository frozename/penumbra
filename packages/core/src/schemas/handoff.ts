import { z } from 'zod';
import { SafeProjectIdSchema } from './project-id.js';

export const HandoffStatusSchema = z.enum([
  'pending',
  'approved',
  'redirected',
  'rejected',
  'dispatched',
  'completed',
  'failed',
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
  error_message: z.string().nullable(),
  cancel_requested_at: z.string().nullable(),
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