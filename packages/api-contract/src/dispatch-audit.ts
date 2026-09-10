import { z } from "zod";

export const DispatchReliabilityStatusSchema = z.enum([
  "complete",
  "missing_dispatch_start",
  "missing_adapter_lifecycle",
  "missing_dispatch_end",
  "non_terminal_stale",
  "cancel_completed",
  "watchdog_only",
  "no_agent_output",
  "no_worktree_activity",
  "tool_failure_with_end_turn",
  "reconcile_missing",
  "agent_declared_done_unverified",
  "timeline_inconsistent",
]);
export type DispatchReliabilityStatus = z.infer<typeof DispatchReliabilityStatusSchema>;

export const DispatchRecommendedActionSchema = z.enum([
  "wait",
  "inspect_worktree",
  "cancel",
  "retry",
  "review_manually",
  "accept",
]);
export type DispatchRecommendedAction = z.infer<typeof DispatchRecommendedActionSchema>;

const DispatchReliabilityEvidenceSchema = z
  .object({
    handoff_status: z.string(),
    event_count: z.number(),
    response_count: z.number(),
    worktree_changed: z.boolean().nullable(),
    dispatch_end_committed: z.boolean().nullable(),
    reconciled: z.boolean().nullable(),
    watchdog_failed: z.boolean(),
    cancel_requested: z.boolean(),
    adapter_streaming: z.boolean().nullable(),
  })
  .loose();
export type DispatchReliabilityEvidence = z.infer<typeof DispatchReliabilityEvidenceSchema>;

const ClassifierDeclineSchema = z.object({
  classifier_declined: z.literal(true),
  decline_reason: z.string().nullable(),
});
export type ClassifierDecline = z.infer<typeof ClassifierDeclineSchema>;

export const DispatchReliabilityReportSchema = z
  .object({
    handoff_id: z.string(),
    status: DispatchReliabilityStatusSchema,
    terminal: z.boolean(),
    trustworthy: z.boolean(),
    summary: z.string(),
    missing_events: z.array(z.string()),
    evidence: DispatchReliabilityEvidenceSchema,
    recommended_action: DispatchRecommendedActionSchema,
    classifier_decline: ClassifierDeclineSchema.optional(),
  })
  .loose();
export type DispatchReliabilityReport = z.infer<typeof DispatchReliabilityReportSchema>;

export const DispatchAuditResponseSchema = z
  .object({
    report: DispatchReliabilityReportSchema,
  })
  .loose();
export type DispatchAuditResponse = z.infer<typeof DispatchAuditResponseSchema>;
