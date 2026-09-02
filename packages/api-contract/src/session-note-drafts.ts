import { z } from "zod";

import { SessionEventSchema } from "./session-events.js";

export const SessionNoteDraftStatusSchema = z.enum([
  "awaiting_approval",
  "approved",
  "edited",
  "rejected",
]);
export type SessionNoteDraftStatus = z.infer<typeof SessionNoteDraftStatusSchema>;

export const SessionNoteDraftSchema = z.object({
  draft_id: z.string().min(1),
  session_id: z.string().nullable(),
  project_id: z.string().nullable(),
  period_key: z.string().min(1),
  skeleton_path: z.string().min(1),
  draft_path: z.string().min(1),
  note_path: z.string().min(1),
  handoff_id: z.string().nullable(),
  status: SessionNoteDraftStatusSchema,
  composed_at: z.string().min(1),
  reviewed_at: z.string().nullable(),
  composed_event_id: z.number().int().nullable(),
  review_event_id: z.number().int().nullable(),
});
export type SessionNoteDraft = z.infer<typeof SessionNoteDraftSchema>;

export const SessionNoteDraftsQuerySchema = z
  .object({
    status: SessionNoteDraftStatusSchema.optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict();
export type SessionNoteDraftsQuery = z.infer<typeof SessionNoteDraftsQuerySchema>;

export const SessionNoteDraftsListResponseSchema = z.object({
  drafts: z.array(SessionNoteDraftSchema),
});
export type SessionNoteDraftsListResponse = z.infer<typeof SessionNoteDraftsListResponseSchema>;

export const SessionNoteApproveRequestSchema = z
  .object({
    draft_id: z.string().min(1),
    approve: z.literal(true),
    body: z.string().optional(),
    overwrite: z.boolean().optional(),
  })
  .strict();
export type SessionNoteApproveRequest = z.infer<typeof SessionNoteApproveRequestSchema>;

export const SessionNoteApproveResponseSchema = z.object({
  draft: SessionNoteDraftSchema,
  event: SessionEventSchema.nullable(),
});
export type SessionNoteApproveResponse = z.infer<typeof SessionNoteApproveResponseSchema>;
