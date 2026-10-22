import { z } from "zod";

export const DispatchEventKindSchema = z.enum([
  "dispatch.start",
  "dispatch.worktree_setup",
  "dispatch.worktree_ready",
  "dispatch.end",
  "acp.server.start",
  "acp.warm_pool.deposit_rejected",
  "acp.warm_pool.prewarm_evicted",
  "acp.session.start",
  "acp.session.reuse",
  "acp.session.end",
  "acp.model_warmup",
  "acp.model_warmup.failed",
  "acp.phase.drift",
  "http.server.start",
  "http.session.start",
  "http.session.open_timeout",
  "http.session.end",
  "http.session.permission",
  "http.stream.first_event_timeout",
  "http.dispatch.error",
  "proc.spawn",
  "proc.kill.sent",
  "proc.exited.resolved",
  "cancel.received",
  "cancel.dispatched",
  "agent.heartbeat",
  "heartbeat.sent",
  "heartbeat.received",
  "terminal.failed",
  "watchdog.tick",
  "watchdog.auto_fail",
  "claim",
  "claim.provider_cap_refused",
  // claim.reoffer meta varies by cause: provider-capacity causes include capacity fields,
  // while orphan_requeue includes recovery fields such as from_worker_id/attempt/max_attempts.
  "claim.reoffer",
  "agent.thought",
  "agent.thought.overflow",
  "agent.thought.digest",
  "agent.thought.signal",
  "agent.tool_call.failed",
  "dream_p4_query_rewritten",
  "dream_p4_query_rewrite_failed",
  "dream_p4_query_rejected_unsearchable",
  "dream_p4_query_skipped",
  "dream_p1_promotion_retry_exhausted",
  "extra_worker_wedge_evicted",
  "shell.session.open",
  "shell.run",
  "shell.session.close",
  "worktree.gc",
  "worktree.gc.unlanded_skipped",
  "worktree.gc.stage_reaped",
  "reconciler.sweep.tick",
  "plan.quarantined",
  "worker.recovery.requeued",
  "worker.recovery.exhausted",
  "worker.recovery.drain_released",
  "lane.override",
  "long_lived.action.expired",
  "workflow.cancel.wait_timeout",
]);
export type DispatchEventKind = z.infer<typeof DispatchEventKindSchema>;

// Read contract for stored rows. "workflow" marks rows a workflow writes
// directly (the wait-timeout cancel marker) and "sweeper" marks stale-handoff
// sweeper ends; the worker POST route keeps its own ["worker", "daemon"] enum,
// so neither source can be posted by a worker.
export const DispatchEventSourceSchema = z.enum(["worker", "daemon", "workflow", "sweeper"]);
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
