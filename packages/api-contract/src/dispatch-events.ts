import { z } from "zod";

export const DispatchEventKindSchema = z.enum([
  "dispatch.start",
  "dispatch.end",
  "acp.server.start",
  "acp.session.start",
  "acp.session.end",
  "http.server.start",
  "http.session.start",
  "http.session.end",
  "proc.spawn",
  "proc.kill.sent",
  "proc.exited.resolved",
  "cancel.received",
  "cancel.dispatched",
  "heartbeat.sent",
  "heartbeat.received",
  "watchdog.tick",
  "watchdog.auto_fail",
  "claim",
  "agent.thought",
  "agent.thought.overflow",
  "agent.thought.digest",
  "agent.thought.signal",
  "agent.tool_call.failed",
  "dream_p4_query_rewritten",
  "dream_p4_query_rewrite_failed",
  "dream_p4_query_rejected_unsearchable",
  "dream_p4_query_skipped",
  "extra_worker_wedge_evicted",
  "shell.session.open",
  "shell.run",
  "shell.session.close",
  "worker.recovery.requeued",
  "worker.recovery.exhausted",
]);
export type DispatchEventKind = z.infer<typeof DispatchEventKindSchema>;

export const DispatchEventSourceSchema = z.enum(["worker", "daemon"]);
export type DispatchEventSource = z.infer<typeof DispatchEventSourceSchema>;

export const DispatchEventSchema = z
  .object({
    handoff_id: z.string(),
    worker_id: z.string().nullable(),
    source: DispatchEventSourceSchema,
    kind: DispatchEventKindSchema,
    ts: z.string(),
    meta: z.unknown().nullable(),
  })
  .loose();
export type DispatchEvent = z.infer<typeof DispatchEventSchema>;

export const DispatchEventsListResponseSchema = z.object({
  events: z.array(DispatchEventSchema),
});

// SSE stream query — replay since (unix-ms), filter by handoff/kind/source.
export const DispatchEventsStreamQuerySchema = z
  .object({
    since: z.coerce.number().int().nonnegative().optional(),
    handoff_id: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    source: DispatchEventSourceSchema.optional(),
  })
  .strict();
