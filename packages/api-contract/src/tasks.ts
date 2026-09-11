import { z } from "zod";

// Mirrors core's TaskStatusSchema (packages/core/src/tasks/schema.ts) — the
// daemon returns these values verbatim (no API-boundary translation). Kept in
// lockstep so the (currently dormant) console validates against reality.
export const TaskStatusSchema = z.enum([
  "pending",
  "leased",
  "done_pending_review",
  "done",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskKindSchema = z.enum(["work", "review", "orchestrate"]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TasksListQuerySchema = z
  .object({
    status: TaskStatusSchema.optional(),
    kind: TaskKindSchema.optional(),
    eligible_for: z.string().min(1).optional(),
    parent_task_id: z.string().min(1).optional(),
    origin: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();
export type TasksListQuery = z.infer<typeof TasksListQuerySchema>;

// Server-side TaskRow shape evolves quickly; treat as loose snapshot.
export const TaskRowSchema = z
  .object({
    task_id: z.string(),
    kind: TaskKindSchema.nullable().optional(),
    status: TaskStatusSchema.nullable().optional(),
    prompt: z.string().nullable().optional(),
    origin: z.string().nullable().optional(),
    parent_task_id: z.string().nullable().optional(),
    created_at: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .loose();
export type TaskRow = z.infer<typeof TaskRowSchema>;

export const TasksListResponseSchema = z.object({
  tasks: z.array(TaskRowSchema),
});
export type TasksListResponse = z.infer<typeof TasksListResponseSchema>;

export const TIER_ORDER = ["economy", "standard", "premium"] as const;
export type Tier = (typeof TIER_ORDER)[number];

export const BoundsInputSchema = z
  .object({
    wall_clock_ms: z.number().int().positive().optional(),
    cost_cents: z.number().int().nonnegative().optional(),
    max_sub_dispatches: z.number().int().positive().optional(),
  })
  .strict();
export type BoundsInput = z.infer<typeof BoundsInputSchema>;

export const TaskPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const ExpectedArtifactSchema = z
  .object({
    type: z.enum(["commit", "file", "pr", "memory", "spec", "review_verdict"]),
    ref: z.string().max(4096).optional(),
  })
  .strict();
export type ExpectedArtifact = z.infer<typeof ExpectedArtifactSchema>;

export const EligibilitySchema = z
  .object({
    required_tags: z.array(z.string()).optional(),
    min_tier: z.enum([...TIER_ORDER]).optional(),
    max_cost_cents: z.number().nonnegative().optional(),
    deny_agents: z.array(z.string()).optional(),
    allow_agents: z.array(z.string()).optional(),
    heartbeat_ttl_ms: z.number().int().positive().optional(),
    preference_window_ms: z.number().int().nonnegative().optional(),
    max_attempts: z.number().int().positive().optional(),
  })
  .strict();
export type Eligibility = z.infer<typeof EligibilitySchema>;

export const ReviewVerdictSchema = z
  .object({
    passed: z.boolean(),
    notes: z.string(),
  })
  .strict();
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const FileTaskInputSchema = z
  .object({
    prompt: z.string().min(1),
    project_id: z.string().min(1).optional(),
    acceptance_criteria: z.string().optional(),
    gh_create: z
      .object({
        repo: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        body: z.string().optional(),
        labels: z.array(z.string()).optional(),
        assignees: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    expected_artifacts: z.array(ExpectedArtifactSchema).optional(),
    eligibility: EligibilitySchema.optional(),
    bounds: BoundsInputSchema.optional(),
    branch_base: z.string().min(1).optional(),
    review_eligibility: EligibilitySchema.optional(),
    priority: TaskPrioritySchema.optional(),
    kind: TaskKindSchema.optional(),
    requires_review: z.boolean().optional(),
    parent_task_id: z.string().optional(),
    origin: z.string().optional(),
    created_by_kind: z.enum(["human", "workflow", "agent"]),
    created_by_id: z.string(),
  })
  .strict();
export type FileTaskInput = z.infer<typeof FileTaskInputSchema>;

export const CompleteTaskInputSchema = z
  .object({
    task_id: z.string(),
    lease_id: z.string(),
    result_summary: z.string().max(16_000),
    result_artifacts: z.array(ExpectedArtifactSchema).max(50).optional(),
    chain_id: z.string().optional(),
    review_verdict: ReviewVerdictSchema.optional(),
  })
  .strict();
export type CompleteTaskInput = z.infer<typeof CompleteTaskInputSchema>;

export const CompleteWithoutLeaseInputSchema = CompleteTaskInputSchema.omit({
  lease_id: true,
}).strict();
export type CompleteWithoutLeaseInput = z.infer<typeof CompleteWithoutLeaseInputSchema>;

export const FailTaskInputSchema = z
  .object({
    task_id: z.string(),
    lease_id: z.string(),
    reason: z.string().min(1),
  })
  .strict();
export type FailTaskInput = z.infer<typeof FailTaskInputSchema>;

export const CancelTaskInputSchema = z
  .object({
    task_id: z.string(),
    reason: z.string().optional(),
  })
  .strict();
export type CancelTaskInput = z.infer<typeof CancelTaskInputSchema>;

export const TaskCreateResponseSchema = z.object({ task_id: z.string() }).loose();
export type TaskCreateResponse = z.infer<typeof TaskCreateResponseSchema>;

export const TaskCancelResponseSchema = z.object({ status: z.literal("cancelled") }).loose();
export type TaskCancelResponse = z.infer<typeof TaskCancelResponseSchema>;

export const TaskFailResponseSchema = z.object({ status: z.literal("failed") }).loose();
export type TaskFailResponse = z.infer<typeof TaskFailResponseSchema>;

export const TaskDraftsPendingResponseSchema = z.object({ drafts: z.array(z.unknown()) }).loose();
export type TaskDraftsPendingResponse = z.infer<typeof TaskDraftsPendingResponseSchema>;

export const TaskDraftEscalationsResponseSchema = z
  .object({ escalations: z.array(z.unknown()) })
  .loose();
export type TaskDraftEscalationsResponse = z.infer<typeof TaskDraftEscalationsResponseSchema>;

export const TaskDraftsPendingQuerySchema = z
  .object({
    latest_event_type: z.enum(["task_draft", "task_draft_escalation"]),
    project_id: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
export type TaskDraftsPendingQuery = z.infer<typeof TaskDraftsPendingQuerySchema>;

export const TaskDraftEscalationsQuerySchema = z
  .object({
    project_id: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
export type TaskDraftEscalationsQuery = z.infer<typeof TaskDraftEscalationsQuerySchema>;
