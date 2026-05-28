import { z } from "zod";
import { DispatchEventSchema } from "./dispatch-events.js";
import { HandoffRowSchema } from "./handoffs.js";

// SSE event payload shapes (the JSON inside `data:` frames).
// Each route emits one of these shapes — field set may grow over time, so loose.

export const HandoffsEventsPayloadSchema = z
  .object({
    handoff: HandoffRowSchema.optional(),
    kind: z.string().optional(),
  })
  .loose();

export const TasksEventsPayloadSchema = z
  .object({
    task_id: z.string(),
    at: z.number(),
    kind: z.string(),
    actor: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()).nullable(),
  })
  .loose();

// Live tail events from /dispatch-events/stream — reuses DispatchEventSchema.
export const DispatchEventsStreamPayloadSchema = DispatchEventSchema;
