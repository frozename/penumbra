import {
  type BoundsInput,
  BoundsInputSchema,
  type CancelTaskInput,
  CancelTaskInputSchema,
  type CompleteTaskInput,
  CompleteTaskInputSchema,
  type CompleteWithoutLeaseInput,
  CompleteWithoutLeaseInputSchema,
  type Eligibility,
  EligibilitySchema,
  type ExpectedArtifact,
  ExpectedArtifactSchema,
  type FailTaskInput,
  FailTaskInputSchema,
  type FileTaskInput,
  FileTaskInputSchema,
  type ReviewVerdict,
  ReviewVerdictSchema,
  type TaskPriority,
  TaskPrioritySchema,
  type Tier,
  TIER_ORDER,
} from "@penumbra/api-contract";
import { z } from "zod";

export {
  type BoundsInput,
  BoundsInputSchema,
  type CancelTaskInput,
  CancelTaskInputSchema,
  type CompleteTaskInput,
  CompleteTaskInputSchema,
  type CompleteWithoutLeaseInput,
  CompleteWithoutLeaseInputSchema,
  type Eligibility,
  EligibilitySchema,
  type ExpectedArtifact,
  ExpectedArtifactSchema,
  type FailTaskInput,
  FailTaskInputSchema,
  type FileTaskInput,
  FileTaskInputSchema,
  type ReviewVerdict,
  ReviewVerdictSchema,
  type TaskPriority,
  TaskPrioritySchema,
  type Tier,
  TIER_ORDER,
};

export const TaskKindSchema = z.enum(["work", "review", "orchestrate"]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const OrchestrateTaskInputSchema = z
  .object({
    branch_base: z.string().min(1).optional(),
  })
  .strict();
export type OrchestrateTaskInput = z.infer<typeof OrchestrateTaskInputSchema>;

export const TaskStatusSchema = z.enum([
  "pending",
  "leased",
  "done_pending_review",
  "done",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export const GhCreateStatusSchema = z.enum(["queued", "pending", "created", "failed"]);
export type GhCreateStatus = z.infer<typeof GhCreateStatusSchema>;

export const TaskEventKindSchema = z.enum([
  "filed",
  "auctioned",
  "leased",
  "heartbeat",
  "completed",
  "cancelled",
  "released",
  "review_filed",
  "review_passed",
  "review_failed",
  "orchestrate_spawned",
  "orchestrate_deferred",
  "orchestrate_resumed",
  "orchestrate_warning",
  "orchestrate_terminated",
]);
export type TaskEventKind = z.infer<typeof TaskEventKindSchema>;

export const LeaseTaskInputSchema = z
  .object({
    task_id: z.string(),
    agent_id: z.string(),
    ttl_ms: z.number().int().positive().optional(),
  })
  .strict();
export type LeaseTaskInput = z.infer<typeof LeaseTaskInputSchema>;

export const HeartbeatTaskInputSchema = z
  .object({
    task_id: z.string(),
    lease_id: z.string(),
  })
  .strict();
export type HeartbeatTaskInput = z.infer<typeof HeartbeatTaskInputSchema>;

export const TaskRecordSchema = z
  .object({
    id: z.string(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
    created_by_kind: z.enum(["human", "workflow", "agent"]),
    created_by_id: z.string(),
    project_id: z.string().nullable(),
    parent_task_id: z.string().nullable(),
    kind: TaskKindSchema,
    priority: TaskPrioritySchema,
    prompt: z.string(),
    acceptance_criteria: z.string().nullable(),
    expected_artifacts: z.array(ExpectedArtifactSchema).nullable(),
    eligibility: EligibilitySchema,
    review_eligibility: EligibilitySchema.nullable(),
    requires_review: z.boolean(),
    bounds_wall_clock_ms: z.number().int().nullable().optional(),
    bounds_cost_cents: z.number().int().nullable().optional(),
    bounds_max_sub_dispatches: z.number().int().nullable().optional(),
    bounds_started_at: z.number().int().nullable().optional(),
    branch_base: z.string().nullable().optional(),
    status: TaskStatusSchema,
    result_summary: z.string().nullable(),
    result_artifacts: z.array(ExpectedArtifactSchema).nullable(),
    failure_reason: z.string().nullable(),
    chain_id: z.string().nullable(),
    origin: z.string().nullable(),
    gh_issue_number: z.number().int().positive().nullable().optional(),
    gh_issue_repo: z.string().min(1).nullable().optional(),
    gh_last_comment_id: z.string().min(1).nullable().optional(),
    gh_comments_synced_at: z.number().int().nullable().optional(),
    gh_create_status: GhCreateStatusSchema.nullable().optional(),
    gh_create_error: z.string().nullable().optional(),
  })
  .strict();
export type TaskRecord = z.infer<typeof TaskRecordSchema>;
