import { z } from 'zod';
import { HandoffStatusSchema } from './handoffs.js';

export const ChainsListQuerySchema = z.object({
  status: HandoffStatusSchema.optional(),
  project_id: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
}).strict();
export type ChainsListQuery = z.infer<typeof ChainsListQuerySchema>;

export const ChainSummarySchema = z.object({
  conversation_id: z.string(),
  project_id: z.string().nullable(),
  latest_status: HandoffStatusSchema,
  latest_ts: z.string(),
  earliest_ts: z.string(),
  handoff_count: z.number().int().nonnegative(),
  root_handoff_id: z.string().nullable(),
  worktree_path: z.string().nullable().optional(),
  worktree_root: z.string().nullable().optional(),
  to_agent: z.string().nullable(),
  to_role: z.string().nullable(),
}).loose();
export type ChainSummary = z.infer<typeof ChainSummarySchema>;

export const ChainsListResponseSchema = z.object({
  chains: z.array(ChainSummarySchema),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export const ChainResponseEventSchema = z.object({
  agent: z.string(),
  text: z.string(),
  ts: z.string(),
  error: z.object({ message: z.string() }).optional(),
}).loose();

export const ChainResponsesPayloadSchema = z.object({
  responses: z.array(ChainResponseEventSchema),
});

export const ChainTerminatedEventSchema = z.object({
  ts: z.string(),
  reason: z.string().nullable(),
  hop_count: z.number().int().nullable(),
  terminal_handoff_id: z.string().nullable().optional(),
  conversation_id: z.string(),
}).loose();

export const ChainHistoryResponseSchema = z.object({
  history: z.array(ChainTerminatedEventSchema),
});

export const ChainRoutingWarningSchema = z.object({
  code: z.literal('prompt_project_mismatch'),
  project_id: z.string(),
  mentioned_paths: z.array(z.string()),
  missing_in_project: z.array(z.string()),
  suggested_project_id: z.string().optional(),
  hint: z.string(),
}).strict();
export type ChainRoutingWarning = z.infer<typeof ChainRoutingWarningSchema>;

export const ChainRoutingAdvisorySchema = z.object({
  code: z.literal('project_registry_unavailable'),
}).strict();
export type ChainRoutingAdvisory = z.infer<typeof ChainRoutingAdvisorySchema>;

export const ChainStartResponseSchema = z.object({
  conversation_id: z.string(),
  handoff_id: z.string(),
  task_class: z.string().optional(),
  lane_id: z.string().nullable().optional(),
  recalled_memory_ids: z.array(z.string()).optional(),
  routed_agent: z.string().optional(),
  routed_role: z.string().nullable().optional(),
  routing_task_type: z.string().nullable().optional(),
  routing_warning: ChainRoutingWarningSchema.optional(),
  routing_advisory: ChainRoutingAdvisorySchema.optional(),
}).loose();
export type ChainStartResponse = z.infer<typeof ChainStartResponseSchema>;
