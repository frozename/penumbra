import { z } from 'zod';
import { SafeProjectIdSchema } from './project-id.js';

export const RecallRequestSchema = z.object({
  query: z.string().min(1),
  project_id: SafeProjectIdSchema.nullish().default(null),
  limit: z.number().int().positive().max(200).default(20),
  include_raw: z.boolean().default(false),
  min_score: z.number().min(0).max(1).default(0),
  sources: z.array(z.enum(['t0', 't1', 't2'])).optional(),
  rrf_k: z.number().optional(),
  session_id: z.string().optional(),
  event_types: z.array(z.string()).optional(),
  file_path: z.string().optional(),
});

export type RecallRequest = z.infer<typeof RecallRequestSchema>;

export const RecallResultSchema = z.object({
  id: z.string(),
  tier: z.enum(['t0', 't1', 't2']),
  score: z.number(),
  fusedScore: z.number().default(0),
  sources: z.array(z.enum(['t0', 't1', 't2'])).default([]),
  title: z.string().nullable(),
  body: z.string(),
  project_id: z.string().nullable(),
  source_session_ids: z.array(z.string()),
  created_at: z.string(),
  ts: z.string(),
  payload: z.unknown().optional(),
});

export type RecallResult = z.infer<typeof RecallResultSchema>;
