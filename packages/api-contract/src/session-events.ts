import { z } from "zod";

export const SessionEventKindSchema = z.enum([
  "session.start",
  "session.stop",
  "session.pre_compact",
  "session.end",
  "continuity.skeleton_generated",
  "continuity.draft_composed",
  "continuity.draft_reviewed",
  "continuity.note_superseded",
  "continuity.boot_pickup",
]);
export type SessionEventKind = z.infer<typeof SessionEventKindSchema>;

export const SessionEventSchema = z
  .object({
    id: z.number().int().positive().optional(),
    session_id: z.string().nullable(),
    related_session_id: z.string().nullable(),
    project_id: z.string().nullable(),
    cwd: z.string().nullable(),
    transcript_path: z.string().nullable(),
    ref_path: z.string().nullable(),
    kind: SessionEventKindSchema,
    ts: z.string(),
    meta: z.unknown().nullable(),
  })
  .loose();
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const SessionEventsQuerySchema = z
  .object({
    session_id: z.string().min(1).optional(),
    kind_prefix: z.string().min(1).optional(),
    since: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict();
export type SessionEventsQuery = z.infer<typeof SessionEventsQuerySchema>;

export const SessionEventsListResponseSchema = z.object({
  events: z.array(SessionEventSchema),
});
export type SessionEventsListResponse = z.infer<typeof SessionEventsListResponseSchema>;
