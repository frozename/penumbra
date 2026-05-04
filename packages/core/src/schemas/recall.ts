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

// ─── 3-layer search workflow (Phase 3) ─────────────────────────────────────
//
// search → timeline → get_observations is the token-efficient recall pattern:
// scan a compact index, anchor a chronological window, hydrate full bodies
// only for the IDs you actually want. Each tool wraps the same SQL surfaces;
// no separate storage is involved.

export const SearchRequestSchema = z.object({
  query: z.string().min(1),
  project_id: SafeProjectIdSchema.nullish().default(null),
  limit: z.number().int().positive().max(200).default(20),
  obs_type: z.string().optional(),
  concept: z.string().optional(),
  file_path: z.string().optional(),
  dateStart: z.string().optional(),
  dateEnd: z.string().optional(),
  tiers: z.array(z.enum(['t1', 't2'])).optional().default(['t1', 't2']),
  offset: z.number().int().min(0).optional().default(0),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const SearchHitSchema = z.object({
  id: z.string(),
  tier: z.enum(['t1', 't2']),
  ts: z.string(),
  obs_type: z.string().nullable().optional(),
  title: z.string(),
  snippet: z.string(),
  project_id: z.string().nullable(),
  score: z.number(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const TimelineRequestSchema = z.object({
  anchor: z.string().min(1),
  depth_before: z.number().int().min(0).max(50).default(3),
  depth_after: z.number().int().min(0).max(50).default(3),
  project_id: SafeProjectIdSchema.nullish(),
});
export type TimelineRequest = z.infer<typeof TimelineRequestSchema>;

export const TimelineEntrySchema = z.object({
  id: z.string(),
  ts: z.string(),
  obs_type: z.string().nullable(),
  title: z.string(),
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export const GetObservationsRequestSchema = z.object({
  ids: z.array(z.string()).min(1).max(50),
});
export type GetObservationsRequest = z.infer<typeof GetObservationsRequestSchema>;

export const ObservationDetailSchema = z.object({
  id: z.string(),
  tier: z.literal('t2'),
  ts: z.string(),
  project_id: z.string().nullable(),
  obs_type: z.string().nullable(),
  severity: z.string().nullable(),
  concepts: z.array(z.string()),
  file_paths: z.array(z.string()),
  title: z.string(),
  body: z.string(),
});
export type ObservationDetail = z.infer<typeof ObservationDetailSchema>;
