import { z } from 'zod';

export const AgentTaskTypeSchema = z.enum([
  'plan_refine',
  'implement_small',
  'implement_substantial',
  'review_adversarial',
  'docs_mechanical',
  'debug_diagnose',
  'smoke_test',
  'health_check',
  'unknown',
]);

export const AgentOutcomeSchema = z.enum([
  'pr_opened',
  'merged',
  'merged_with_concerns',
  'no_changes',
  'typecheck_failed',
  'test_failed',
  'pr_creation_failed',
  'rejected',
  'failed',
  'partial',
  'bypassed',
]);

export const AgentSmokePassSchema = z.enum(['y', 'n', 'partial', 'n/a']);
export const AgentPerformanceSourceSchema = z.enum(['reconciler', 'manual_seed', 'operator']);

export type AgentTaskType = z.infer<typeof AgentTaskTypeSchema>;
export type AgentOutcome = z.infer<typeof AgentOutcomeSchema>;
export type AgentSmokePass = z.infer<typeof AgentSmokePassSchema>;
export type AgentPerformanceSource = z.infer<typeof AgentPerformanceSourceSchema>;

export const AgentPerformanceRowSchema = z.object({
  performance_id: z.string(),
  ts: z.string(),
  handoff_id: z.string(),
  conversation_id: z.string().nullable(),
  project_id: z.string().nullable(),
  agent_name: z.string(),
  task_type: AgentTaskTypeSchema,
  outcome: AgentOutcomeSchema,
  rounds: z.number().int().nullable(),
  smoke_pass: AgentSmokePassSchema.nullable(),
  reviewer_findings: z.number().int().nullable(),
  maestro_score: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  tokens_used: z.number().int().nullable(),
  latency_ms: z.number().int().nullable(),
  source: AgentPerformanceSourceSchema,
  notes: z.string().nullable(),
  metadata_json: z.string(),
});
export type AgentPerformanceRow = z.infer<typeof AgentPerformanceRowSchema>;

const MergeResultStatusSchema = z.enum([
  'pr_opened',
  'pr_creation_failed',
  'typecheck_failed',
  'test_failed',
  'merged',
  'rebased',
  'rebase_conflict',
  'no_changes',
]);

export const AgentPerformanceCaptureFromReconcilerSchema = z.object({
  handoff_id: z.string().min(1),
  task_type: AgentTaskTypeSchema.optional(),
  result: z.object({
    status: MergeResultStatusSchema,
    pr_url: z.string().url().optional(),
    regression_summary: z.string().optional(),
    timed_out: z.boolean().optional(),
  }).passthrough(),
});
export type AgentPerformanceCaptureFromReconciler = z.infer<typeof AgentPerformanceCaptureFromReconcilerSchema>;

export const AgentRankInputSchema = z.object({
  task_type: AgentTaskTypeSchema,
  since: z.string().datetime().optional(),
  min_samples: z.coerce.number().int().min(1).default(1),
  include_neutral: z.preprocess(
    (v) => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().default(false),
  ),
});
export type AgentRankInput = z.infer<typeof AgentRankInputSchema>;

export const AgentRankOutputSchema = z.object({
  task_type: AgentTaskTypeSchema,
  window: z.object({ from: z.string().nullable(), to: z.string() }),
  candidates: z.array(z.object({
    agent_name: z.string(),
    samples: z.number().int(),
    successes: z.number().int(),
    failures: z.number().int(),
    neutral: z.number().int(),
    success_rate: z.number(),
    avg_rounds: z.number().nullable(),
    avg_latency_ms: z.number().nullable(),
    cost_per_success_usd: z.number().nullable(),
    avg_reviewer_findings: z.number().nullable(),
    score: z.number(),
    last_outcome_at: z.string(),
  })),
});
export type AgentRankOutput = z.infer<typeof AgentRankOutputSchema>;

export function mapMergeStatusToAgentOutcome(status: string): AgentOutcome {
  switch (status) {
    case 'pr_opened':
      return 'pr_opened';
    case 'no_changes':
      return 'no_changes';
    case 'typecheck_failed':
      return 'typecheck_failed';
    case 'test_failed':
      return 'test_failed';
    case 'pr_creation_failed':
      return 'pr_creation_failed';
    case 'merged':
    case 'rebased':
      return 'merged';
    case 'rebase_conflict':
      return 'failed';
    default:
      return 'failed';
  }
}

export function inferAgentTaskType(message: string, status?: string): AgentTaskType {
  const explicit = /^\s*Task type:\s*([a-z_]+)\s*$/im.exec(message);
  if (explicit && AgentTaskTypeSchema.safeParse(explicit[1]).success) {
    return explicit[1] as AgentTaskType;
  }
  if (/Review-only task/i.test(message)) return 'review_adversarial';
  if (/Implementation Plan|plan to execute/i.test(message)) return 'implement_substantial';
  if (status === 'no_changes' && /Review-only task/i.test(message)) return 'review_adversarial';
  return 'unknown';
}
