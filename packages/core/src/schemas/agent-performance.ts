import { z } from "zod";

export const AgentTaskTypeSchema = z.enum([
  "plan_refine",
  "implement_small",
  "implement_substantial",
  "review_adversarial",
  "docs_mechanical",
  "debug_diagnose",
  "smoke_test",
  "health_check",
  "unknown",
]);

export const NON_MUTATING_TASK_TYPES = [
  "review_adversarial",
  "debug_diagnose",
  "health_check",
  "smoke_test",
  "plan_refine",
] as const satisfies readonly AgentTaskType[];

export const AgentOutcomeSchema = z.enum([
  "pr_opened",
  "merged",
  "merged_with_concerns",
  "no_changes",
  "typecheck_failed",
  "test_failed",
  "pr_creation_failed",
  "rejected",
  "failed",
  "partial",
  "bypassed",
  "completed_with_output",
]);

export const AgentSmokePassSchema = z.enum(["y", "n", "partial", "n/a"]);
export const AgentEvidenceFlagSchema = z.enum(["y", "n", "n/a"]);
export const AgentBooleanFlagSchema = z.enum(["y", "n"]);
export const AgentPerformanceSourceSchema = z.enum([
  "reconciler",
  "worker",
  "manual_seed",
  "operator",
]);
export const AgentKindSchema = z.enum(["coding", "long_lived"]);
export const DEFAULT_AGENT_KIND: AgentKind = "coding";

export type AgentTaskType = z.infer<typeof AgentTaskTypeSchema>;
export type AgentOutcome = z.infer<typeof AgentOutcomeSchema>;
export type AgentSmokePass = z.infer<typeof AgentSmokePassSchema>;
export type AgentEvidenceFlag = z.infer<typeof AgentEvidenceFlagSchema>;
export type AgentBooleanFlag = z.infer<typeof AgentBooleanFlagSchema>;
export type AgentPerformanceSource = z.infer<typeof AgentPerformanceSourceSchema>;
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const AgentPerformanceRowSchema = z.object({
  performance_id: z.string(),
  ts: z.string(),
  handoff_id: z.string(),
  conversation_id: z.string().nullable(),
  project_id: z.string().nullable(),
  agent_name: z.string(),
  task_type: AgentTaskTypeSchema,
  outcome: AgentOutcomeSchema,
  gate_outcome: z.string().nullable().optional(),
  rounds: z.number().int().nullable(),
  smoke_pass: AgentSmokePassSchema.nullable(),
  reviewer_findings: z.number().int().nullable(),
  maestro_score: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  tokens_used: z.number().int().nullable(),
  latency_ms: z.number().int().nullable(),
  exec_ms: z.number().int().nullable().optional(),
  framework_overhead_ms: z.number().int().nullable().optional(),
  source: AgentPerformanceSourceSchema,
  notes: z.string().nullable(),
  reliability_status: z.string().nullable().optional(),
  failure_class: z.string().nullable().optional(),
  artifact_present: AgentEvidenceFlagSchema.nullable().optional(),
  verification_present: AgentEvidenceFlagSchema.nullable().optional(),
  maestro_takeover_required: AgentBooleanFlagSchema.nullable().optional(),
  empty_response: AgentBooleanFlagSchema.nullable().optional(),
  worktree_changed: AgentEvidenceFlagSchema.nullable().optional(),
  /** @deprecated Dead column: never written in production (0 of ~42k rows non-null as of 2026-08-27) and read by nothing. Do not adopt for new writes; kept only because dropping a column from the live DB is not worth a migration. */
  reconcile_status: z.string().nullable().optional(),
  environment_failure: AgentBooleanFlagSchema.nullable().optional(),
  trust_score: z.number().nullable().optional(),
  agent_kind: AgentKindSchema.optional(),
  metadata_json: z.string(),
});
export type AgentPerformanceRow = z.infer<typeof AgentPerformanceRowSchema>;

export const MergeResultStatusSchema = z.enum([
  "pr_opened",
  "pr_creation_failed",
  "typecheck_failed",
  "test_failed",
  "merged",
  "rebased",
  "rebase_conflict",
  "no_changes",
  "verified",
]);

export const AgentPerformanceCaptureFromReconcilerSchema = z.object({
  handoff_id: z.string().min(1),
  task_type: AgentTaskTypeSchema.optional(),
  wall_ms: z.number().nonnegative().nullable().optional(),
  framework_overhead_ms: z.number().nonnegative().nullable().optional(),
  result: z.looseObject({
    status: MergeResultStatusSchema,
    pr_url: z.url().optional(),
    regression_summary: z.string().optional(),
    timed_out: z.boolean().optional(),
    verification_environment_error: z.literal(true).optional(),
  }),
});
export type AgentPerformanceCaptureFromReconciler = z.infer<
  typeof AgentPerformanceCaptureFromReconcilerSchema
>;

export const AgentPerformanceCaptureFromDispatchSchema = z.object({
  handoff_id: z.string().min(1),
  task_type: AgentTaskTypeSchema.optional(),
  reason: z.enum(["completed", "max_hops", "cancelled", "error"]),
  // Optional snapshot from the worker's getWorktreeSnapshot probe at
  // dispatch.end time. Authoritative when present — preferred over reading
  // dispatch_events, since the events POST and the capture POST race and
  // the events row may not be visible yet.
  worktree_changed: z.boolean().nullable().optional(),
  wall_ms: z.number().nonnegative().nullable().optional(),
  framework_overhead_ms: z.number().nonnegative().nullable().optional(),
  final_response_chars: z.number().int().nonnegative().max(65536).optional(),
  has_meaningful_output: z.boolean().optional(),
});
export type AgentPerformanceCaptureFromDispatch = z.infer<
  typeof AgentPerformanceCaptureFromDispatchSchema
>;

export const AgentRankInputSchema = z.object({
  task_type: AgentTaskTypeSchema,
  since: z
    .string()
    .optional()
    .describe("ISO 8601 datetime (UTC)")
    .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), {
      message: "since must be a valid ISO 8601 datetime",
    }),
  min_samples: z.coerce.number().int().min(1).default(1),
  agent_kind: AgentKindSchema.optional(),
  include_neutral: z.preprocess(
    (v) => (v === "true" ? true : v === "false" ? false : v),
    z.boolean().default(false),
  ),
  include_cost: z.preprocess(
    (v) => (v === "true" ? true : v === "false" ? false : v),
    z.boolean().default(false),
  ),
});
export type AgentRankInput = z.infer<typeof AgentRankInputSchema>;

export const RecordOperatorAgentPerformanceInputSchema = z.object({
  handoff_id: z.string().min(1),
  task_type: AgentTaskTypeSchema,
  outcome: AgentOutcomeSchema,
  rounds: z.number().int().min(0).optional(),
  smoke_pass: AgentSmokePassSchema.optional(),
  reviewer_findings: z.number().int().min(0).optional(),
  maestro_score: z.number().int().min(1).max(5).optional(),
  cost_usd: z.number().min(0).optional(),
  notes: z.string().optional(),
});
export type RecordOperatorAgentPerformanceInput = z.infer<
  typeof RecordOperatorAgentPerformanceInputSchema
>;

export const AgentPerformanceMarkdownParseInputSchema = z.object({
  markdown: z.string(),
  sourcePath: z.string(),
  projectId: z.string().nullable().optional(),
});
export type AgentPerformanceMarkdownParseInput = z.infer<
  typeof AgentPerformanceMarkdownParseInputSchema
>;

export const ImportMarkdownResultSchema = z.object({
  imported: z.number().int(),
  skipped: z.number().int(),
});
export type ImportMarkdownResult = z.infer<typeof ImportMarkdownResultSchema>;

export const AgentRankOutputSchema = z.object({
  task_type: AgentTaskTypeSchema,
  window: z.object({ from: z.string().nullable(), to: z.string() }),
  candidates: z.array(
    z.object({
      agent_name: z.string(),
      samples: z.number().int(),
      successes: z.number().int(),
      failures: z.number().int(),
      neutral: z.number().int(),
      success_rate: z.number(),
      avg_rounds: z.number().nullable(),
      avg_latency_ms: z.number().nullable(),
      avg_exec_ms: z.number().nullable(),
      cost_per_success_usd: z.number().nullable(),
      avg_reviewer_findings: z.number().nullable(),
      avg_trust_score: z.number().nullable(),
      gate_verdict_coverage: z.number(),
      gate_pass_rate: z.number(),
      score: z.number(),
      last_outcome_at: z.string(),
    }),
  ),
});
export type AgentRankOutput = z.infer<typeof AgentRankOutputSchema>;

export function mapMergeStatusToAgentOutcome(status: string): AgentOutcome {
  switch (status) {
    case "pr_opened":
      return "pr_opened";
    case "no_changes":
      return "no_changes";
    case "typecheck_failed":
      return "typecheck_failed";
    case "test_failed":
      return "test_failed";
    case "pr_creation_failed":
      return "pr_creation_failed";
    case "merged":
    case "rebased":
      return "merged";
    case "verified":
      return "completed_with_output";
    case "rebase_conflict":
      return "failed";
    default:
      return "failed";
  }
}

export function mapDispatchReasonToAgentOutcome(
  reason: string,
  signals: {
    silent_failure?: boolean;
    tool_failure_count?: number;
  } = {},
): AgentOutcome {
  switch (reason) {
    case "completed": {
      // A "completed" dispatch on an implementation task that produced no
      // worktree changes is a silent failure (the gemini hallucination
      // pattern: agent reports success, no files written). Score it as a
      // real failure so agent-rank deprioritises agents that exhibit this.
      // Without this, completed-but-empty dispatches score 0.5 (neutral).
      if (signals.silent_failure) return "failed";
      return "no_changes";
    }
    case "max_hops":
      return "partial";
    case "cancelled":
      return "rejected";
    case "error":
      return "failed";
    default:
      return "failed";
  }
}

export function inferAgentTaskType(message: string, status?: string): AgentTaskType {
  const explicit = /^\s*Task type:\s*([a-z_]+)\s*$/im.exec(message);
  if (explicit && AgentTaskTypeSchema.safeParse(explicit[1]).success) {
    return explicit[1] as AgentTaskType;
  }
  if (/Review-only task/i.test(message)) return "review_adversarial";
  if (/Implementation Plan|plan to execute/i.test(message)) return "implement_substantial";
  if (status === "no_changes" && /Review-only task/i.test(message)) return "review_adversarial";
  return "unknown";
}

export function inferAgentTaskTypeForRole(
  message: string,
  role: string | null | undefined,
  status?: string,
): AgentTaskType {
  const inferred = inferAgentTaskType(message, status);
  if (inferred !== "unknown") return inferred;
  switch (role) {
    case "planner":
      return "plan_refine";
    case "executor":
      return "implement_substantial";
    case "reviewer":
      return "review_adversarial";
    case null:
    case undefined:
    default:
      return "unknown";
  }
}
