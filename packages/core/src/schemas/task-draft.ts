import { z } from "zod";
import { TaskDraftLifecycleEventType, TASK_DRAFT_LIFECYCLE_EVENT_TYPES } from "./event.js";

export const TaskDraftEvidenceSchema = z
  .object({
    conv_ids: z.array(z.string()).optional(),
    commits: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
    session_id: z.string().optional(),
  })
  .partial();

export const TaskDraftProvenanceSchema = z.object({
  filing_path: z.string().min(1),
  session_id: z.string().min(1),
  extractor_version: z.string().min(1),
  filtered_by: z.array(z.string()).min(1),
});

export const TaskDraftPayloadSchema = z.object({
  draft_id: z.string().uuid(),
  prompt: z.string().min(1),
  affects_projects: z.array(z.string()).min(1),
  evidence: TaskDraftEvidenceSchema,
  auto_ok: z.boolean(),
  filed_by_agent: z.string().min(1),
  filed_via: z.enum(["skill_inline", "stop_hook"]),
  parent_draft_id: z.string().uuid().nullable(),
  recovery_count: z.number().int().nonnegative().optional(),
  recovered_from: z.string().min(1).optional(),
  provenance: TaskDraftProvenanceSchema.optional(),
});

export const TaskDraftRefiningPayloadSchema = z.object({
  draft_id: z.string().uuid(),
});

export const TaskDraftPromotedPayloadSchema = z.object({
  draft_id: z.string().uuid(),
  task_ids: z.array(z.string().min(1)).min(1),
});

export const TaskDraftStalePayloadSchema = z.object({
  draft_id: z.string().uuid(),
  stale_reason: z.enum([
    "path_removed",
    "resolved_by",
    "duplicate_of",
    "ttl_expired",
    "refining_stuck",
    "refining_stuck_exhausted",
  ]),
  details: z.string().optional(),
});

export const TaskDraftDuplicatePayloadSchema = z.object({
  draft_id: z.string().uuid(),
  duplicate_of_task_id: z.string().min(1),
});

export const TaskDraftEscalationPayloadSchema = z.object({
  draft_id: z.string().uuid(),
  escalation_reason: z.string().min(1),
});

export const TaskDraftLifecyclePayloadSchema = z.discriminatedUnion("event_type", [
  TaskDraftPayloadSchema.extend({ event_type: z.literal(TASK_DRAFT_LIFECYCLE_EVENT_TYPES[0]) }),
  TaskDraftRefiningPayloadSchema.extend({
    event_type: z.literal(TASK_DRAFT_LIFECYCLE_EVENT_TYPES[1]),
  }),
  TaskDraftPromotedPayloadSchema.extend({
    event_type: z.literal(TASK_DRAFT_LIFECYCLE_EVENT_TYPES[2]),
  }),
  TaskDraftStalePayloadSchema.extend({
    event_type: z.literal(TASK_DRAFT_LIFECYCLE_EVENT_TYPES[3]),
  }),
  TaskDraftDuplicatePayloadSchema.extend({
    event_type: z.literal(TASK_DRAFT_LIFECYCLE_EVENT_TYPES[4]),
  }),
  TaskDraftEscalationPayloadSchema.extend({
    event_type: z.literal(TASK_DRAFT_LIFECYCLE_EVENT_TYPES[5]),
  }),
]);

export type TaskDraftProvenance = z.infer<typeof TaskDraftProvenanceSchema>;
export type TaskDraftPayload = z.infer<typeof TaskDraftPayloadSchema>;
export type TaskDraftRefiningPayload = z.infer<typeof TaskDraftRefiningPayloadSchema>;
export type TaskDraftPromotedPayload = z.infer<typeof TaskDraftPromotedPayloadSchema>;
export type TaskDraftStalePayload = z.infer<typeof TaskDraftStalePayloadSchema>;
export type TaskDraftDuplicatePayload = z.infer<typeof TaskDraftDuplicatePayloadSchema>;
export type TaskDraftEscalationPayload = z.infer<typeof TaskDraftEscalationPayloadSchema>;
export type TaskDraftLifecyclePayload = z.infer<typeof TaskDraftLifecyclePayloadSchema>;

export type ParsedTaskDraftLifecyclePayload =
  | TaskDraftPayload
  | TaskDraftRefiningPayload
  | TaskDraftPromotedPayload
  | TaskDraftStalePayload
  | TaskDraftDuplicatePayload
  | TaskDraftEscalationPayload;

const TASK_DRAFT_LIFECYCLE_DISPATCH_TABLE: Record<TaskDraftLifecycleEventType, z.ZodTypeAny> = {
  task_draft: TaskDraftPayloadSchema,
  task_draft_refining: TaskDraftRefiningPayloadSchema,
  task_draft_promoted: TaskDraftPromotedPayloadSchema,
  task_draft_stale: TaskDraftStalePayloadSchema,
  task_draft_duplicate: TaskDraftDuplicatePayloadSchema,
  task_draft_escalation: TaskDraftEscalationPayloadSchema,
};

export function parseTaskDraftLifecyclePayload(
  eventType: TaskDraftLifecycleEventType,
  payload: unknown,
): ParsedTaskDraftLifecyclePayload {
  const schema = TASK_DRAFT_LIFECYCLE_DISPATCH_TABLE[eventType];
  if (!schema) throw new Error(`Unsupported task draft lifecycle event type: ${eventType}`);
  return schema.parse(payload) as ParsedTaskDraftLifecyclePayload;
}
