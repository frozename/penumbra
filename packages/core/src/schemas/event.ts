import { z } from "zod";

import { SafeProjectIdSchema } from "./project-id.js";

export const TASK_DRAFT_LIFECYCLE_EVENT_TYPES = [
  "task_draft",
  "task_draft_refining",
  "task_draft_promoted",
  "task_draft_stale",
  "task_draft_duplicate",
  "task_draft_escalation",
] as const;

export type TaskDraftLifecycleEventType = (typeof TASK_DRAFT_LIFECYCLE_EVENT_TYPES)[number];

export const SourceSchema = z.enum([
  "mcp",
  "transcript",
  "sirius-middleware",
  "claude-code",
  "agentchat",
  "daemon",
]);
export const LaneSchema = z.enum(["local", "cloud", "cli-subscription", "unknown", "system"]);
export const EventTypeSchema = z.enum([
  "agent-prompt",
  "agent-tool-use",
  "agent-response",
  "agent-thought",
  "agent-handoff",
  "user-prompt",
  "request",
  "response",
  "chain-terminated",
  "usage-update",
  "rate-limit-snapshot",
  "provider-capacity-error",
  "subscription-pressure-cap-trip",
  "subscription-pressure-fallback",
  "permission-requested",
  "permission-decided",
  "permission-expired",
  "fs.write_applied",
  "fs.edit_applied",
  "terminal.spawned",
  "terminal.exited",
  "terminal.killed",
  "reconciler.verdict",
  "reconciler.pr.swept",
  "lane.orphan-swept",
  "dispatch.landed",
  "lifecycle_lock_held",
  "task.gh_state_pulled",
  ...TASK_DRAFT_LIFECYCLE_EVENT_TYPES,
  "gh_issue_comment",
  "workflow.run",
  "workflow.recall",
  "workflow.outcome",
  // Maestro output redaction (see packages/agentchat/src/worker/maestro-output-redactor.ts).
  // These are emitted by CapturePort when a redactor is configured:
  //  - *-blocked: the regular event is suppressed; this carries the hits + decision
  //  - *-redaction-hit: response/tool-use is still dispatched with redacted content; this carries audit details
  //  - *-redaction-bypassed: bypass is on; both this event and the unredacted regular event are dispatched
  "agent-response-blocked",
  "agent-response-redaction-hit",
  "agent-response-redaction-bypassed",
  "agent-tool-use-blocked",
  "agent-tool-use-redaction-hit",
  "agent-tool-use-redaction-bypassed",
  "agent-tool-result-blocked",
  "agent-tool-result-redaction-hit",
  "agent-tool-result-redaction-bypassed",
]);

export const OriginSchema = z.enum(["maestro", "dispatch", "unknown"]);
export type Origin = z.infer<typeof OriginSchema>;

export const T0EventSchema = z.object({
  event_id: z.string(),
  ts: z.string(),
  ingest_ts: z.string(),
  source: SourceSchema,
  source_detail: z.string().nullable(),
  project_id: SafeProjectIdSchema.nullable(),
  user_id: z.string(),
  machine_id: z.string(),
  session_id: z.string().nullable(),
  event_type: EventTypeSchema,
  lane: LaneSchema,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  tokens_in: z.number().int().nullable(),
  tokens_out: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  latency_ms: z.number().int().nullable(),
  request_id: z.string().nullable(),
  payload_json: z.record(z.string(), z.unknown()),
  payload_summary: z.string().nullable(),
  origin: OriginSchema.nullable(),
});

export type T0Event = z.infer<typeof T0EventSchema>;

export const T0EventInputSchema = T0EventSchema.partial({
  event_id: true,
  ingest_ts: true,
  source_detail: true,
  project_id: true,
  session_id: true,
  provider: true,
  model: true,
  tokens_in: true,
  tokens_out: true,
  cost_usd: true,
  latency_ms: true,
  request_id: true,
  payload_summary: true,
  origin: true,
});

export type T0EventInput = z.infer<typeof T0EventInputSchema>;
