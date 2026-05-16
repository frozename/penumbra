import { z } from 'zod';
import { TaskDraftLifecycleEventType, TASK_DRAFT_LIFECYCLE_EVENT_TYPES } from './event.js';

export const TaskDraftEvidenceSchema = z.object({
  conv_ids: z.array(z.string()).optional(),
  commits: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  session_id: z.string().optional(),
}).partial();

export const TaskDraftPayloadSchema = z.object({
  draft_id: z.string().uuid(),
  prompt: z.string().min(1),
  affects_projects: z.array(z.string()).min(1),
  evidence: TaskDraftEvidenceSchema,
  auto_ok: z.boolean(),
  filed_by_agent: z.string().min(1),
  filed_via: z.enum(['skill_inline', 'stop_hook']),
  parent_draft_id: z.string().uuid().nullable(),
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
  stale_reason: z.enum(['path_removed', 'resolved_by', 'duplicate_of', 'ttl_expired', 'refining_stuck']),
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

export const TaskDraftLifecyclePayloadSchema = z.discriminatedUnion('event_type', [
  TaskDraftPayloadSchema.extend({ event_type: z.literal(TASK_DRAFT_LIFECYCLE_EVENT_TYPES[0]) }),
  TaskDraftRefiningPayloadSchema.extend({ event_type: z.literal(TASK_DRAFT_LIFECYCLE_EVENT_TYPES[1]) }),
  TaskDraftPromotedPayloadSchema.extend({ event_type: z.literal(TASK_DRAFT_LIFECYCLE_EVENT_TYPES[2]) }),
  TaskDraftStalePayloadSchema.extend({ event_type: z.literal(TASK_DRAFT_LIFECYCLE_EVENT_TYPES[3]) }),
  TaskDraftDuplicatePayloadSchema.extend({ event_type: z.literal(TASK_DRAFT_LIFECYCLE_EVENT_TYPES[4]) }),
  TaskDraftEscalationPayloadSchema.extend({ event_type: z.literal(TASK_DRAFT_LIFECYCLE_EVENT_TYPES[5]) }),
]);

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

export function parseTaskDraftLifecyclePayload(eventType: TaskDraftLifecycleEventType, payload: unknown): ParsedTaskDraftLifecyclePayload {
  if (eventType === TASK_DRAFT_LIFECYCLE_EVENT_TYPES[0]) return TaskDraftPayloadSchema.parse(payload);
  if (eventType === TASK_DRAFT_LIFECYCLE_EVENT_TYPES[1]) return TaskDraftRefiningPayloadSchema.parse(payload);
  if (eventType === TASK_DRAFT_LIFECYCLE_EVENT_TYPES[2]) return TaskDraftPromotedPayloadSchema.parse(payload);
  if (eventType === TASK_DRAFT_LIFECYCLE_EVENT_TYPES[3]) return TaskDraftStalePayloadSchema.parse(payload);
  if (eventType === TASK_DRAFT_LIFECYCLE_EVENT_TYPES[4]) return TaskDraftDuplicatePayloadSchema.parse(payload);
  if (eventType === TASK_DRAFT_LIFECYCLE_EVENT_TYPES[5]) return TaskDraftEscalationPayloadSchema.parse(payload);

  throw new Error(`Unsupported task draft lifecycle event type: ${eventType}`);
}
