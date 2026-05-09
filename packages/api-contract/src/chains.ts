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
