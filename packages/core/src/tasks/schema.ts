import { z } from 'zod';

export const TaskKindSchema = z.enum(['work', 'review', 'orchestrate']);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const BoundsInputSchema = z.object({
  wall_clock_ms: z.number().int().positive().optional(),
  cost_cents: z.number().int().nonnegative().optional(),
  max_sub_dispatches: z.number().int().positive().optional(),
}).strict();
export type BoundsInput = z.infer<typeof BoundsInputSchema>;

export const TaskPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const TaskStatusSchema = z.enum(['pending', 'leased', 'done_pending_review', 'done', 'failed', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskEventKindSchema = z.enum([
  'filed',
  'auctioned',
  'leased',
  'heartbeat',
  'completed',
  'cancelled',
  'released',
  'review_filed',
  'review_passed',
  'review_failed',
  'orchestrate_spawned',
  'orchestrate_warning',
  'orchestrate_terminated',
]);
export type TaskEventKind = z.infer<typeof TaskEventKindSchema>;

export const EligibilitySchema = z.object({
  required_tags: z.array(z.string()).optional(),
  min_tier: z.string().optional(),
  max_cost_cents: z.number().nonnegative().optional(),
  deny_agents: z.array(z.string()).optional(),
  allow_agents: z.array(z.string()).optional(),
  heartbeat_ttl_ms: z.number().int().positive().optional(),
  preference_window_ms: z.number().int().nonnegative().optional(),
  max_attempts: z.number().int().positive().optional(),
}).strict();
export type Eligibility = z.infer<typeof EligibilitySchema>;

export const ExpectedArtifactSchema = z.object({
  type: z.enum(['commit', 'file', 'pr', 'memory', 'spec', 'review_verdict']),
  ref: z.string().optional(),
}).strict();
export type ExpectedArtifact = z.infer<typeof ExpectedArtifactSchema>;

export const ReviewVerdictSchema = z.object({
  passed: z.boolean(),
  notes: z.string(),
}).strict();
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const FileTaskInputSchema = z.object({
  prompt: z.string().min(1),
  project_id: z.string().min(1).optional(),
  acceptance_criteria: z.string().optional(),
  expected_artifacts: z.array(ExpectedArtifactSchema).optional(),
  eligibility: EligibilitySchema.optional(),
  bounds: BoundsInputSchema.optional(),
  review_eligibility: EligibilitySchema.optional(),
  priority: TaskPrioritySchema.optional(),
  kind: TaskKindSchema.optional(),
  requires_review: z.boolean().optional(),
  parent_task_id: z.string().optional(),
  origin: z.string().optional(),
  created_by_kind: z.enum(['human', 'workflow', 'agent']),
  created_by_id: z.string(),
}).strict();
export type FileTaskInput = z.infer<typeof FileTaskInputSchema>;

export const LeaseTaskInputSchema = z.object({
  task_id: z.string(),
  agent_id: z.string(),
  ttl_ms: z.number().int().positive().optional(),
}).strict();
export type LeaseTaskInput = z.infer<typeof LeaseTaskInputSchema>;

export const HeartbeatTaskInputSchema = z.object({
  task_id: z.string(),
  lease_id: z.string(),
}).strict();
export type HeartbeatTaskInput = z.infer<typeof HeartbeatTaskInputSchema>;

export const CompleteTaskInputSchema = z.object({
  task_id: z.string(),
  lease_id: z.string(),
  result_summary: z.string(),
  result_artifacts: z.array(ExpectedArtifactSchema).optional(),
  chain_id: z.string().optional(),
  review_verdict: ReviewVerdictSchema.optional(),
}).strict();
export type CompleteTaskInput = z.infer<typeof CompleteTaskInputSchema>;

export const FailTaskInputSchema = z.object({
  task_id: z.string(),
  lease_id: z.string(),
  reason: z.string().min(1),
}).strict();
export type FailTaskInput = z.infer<typeof FailTaskInputSchema>;

export const CancelTaskInputSchema = z.object({
  task_id: z.string(),
  reason: z.string().optional(),
}).strict();
export type CancelTaskInput = z.infer<typeof CancelTaskInputSchema>;

export const TaskRecordSchema = z.object({
  id: z.string(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  created_by_kind: z.enum(['human', 'workflow', 'agent']),
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
  status: TaskStatusSchema,
  result_summary: z.string().nullable(),
  result_artifacts: z.array(ExpectedArtifactSchema).nullable(),
  failure_reason: z.string().nullable(),
  chain_id: z.string().nullable(),
  origin: z.string().nullable(),
}).strict();
export type TaskRecord = z.infer<typeof TaskRecordSchema>;
