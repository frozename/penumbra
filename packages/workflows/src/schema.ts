import { z } from 'zod';
import {
  BoundsInputSchema,
  EligibilitySchema,
  ExpectedArtifactSchema,
  TaskKindSchema,
  TaskPrioritySchema,
} from '@penumbra/core';

export const TriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slash'), command: z.string().min(1) }),
  z.object({
    kind: z.literal('lifecycle'),
    event: z.enum([
      'session-start',
      'pre-compact',
      'stop',
      'user-prompt-submit',
      'pre-tool-use',
      'post-tool-use',
    ]),
    filter: z
      .object({
        tool_name: z.array(z.string().min(1)).min(1).optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal('state-threshold'),
    metric: z.enum(['queue-idle-min', 'time-since-last-handoff-min', 'pending-handoffs', 'commits-since-last-handoff', 'context-window-percent']),
    op: z.enum(['>', '<']),
    value: z.number(),
    poll_interval_s: z.number().int().positive().optional(),
  }),
  z.object({ kind: z.literal('manual') }),
]);

const ArgsRecord = z.record(z.string(), z.unknown());

export const RecallSourceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('memory_search'), args: ArgsRecord }),
  z.object({ source: z.literal('memory_timeline'), args: ArgsRecord }),
  z.object({ source: z.literal('memory_get_observations'), args: ArgsRecord }),
  z.object({ source: z.literal('git.log'), args: ArgsRecord }),
  z.object({ source: z.literal('git.show'), args: ArgsRecord }),
  z.object({ source: z.literal('git.diff'), args: ArgsRecord }),
  z.object({
    source: z.literal('file.contents'),
    args: z.object({
      path: z.string().min(1),
      max_bytes: z.number().int().positive().optional(),
      allowed_roots: z.array(z.string()).optional(),
    }),
  }),
  z.object({ source: z.literal('dispatch_events'), args: ArgsRecord }),
  z.object({ source: z.literal('handoff_list_pending'), args: ArgsRecord.optional() }),
  z.object({ source: z.literal('agents'), args: ArgsRecord.optional() }),
  z.object({ source: z.literal('fs_glob'), args: ArgsRecord }),
  z.object({ source: z.literal('fs_grep'), args: ArgsRecord }),
  z.object({ source: z.literal('daemon.endpoint'), args: z.object({ path: z.string() }) }),
]);

export const ProcessGateNameSchema = z.enum([
  'verification-before-complete',
  'tdd',
  'brainstorm-first',
  'worktree-isolation',
]);

export const OutputSinkSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file'),
    path: z.string(),
    mode: z.enum(['overwrite', 'append', 'skip-if-exists']).optional(),
  }),
  z.object({ kind: z.literal('clipboard') }),
  z.object({ kind: z.literal('next-session-prompt') }),
  z.object({ kind: z.literal('commit'), message: z.string() }),
  z.object({ kind: z.literal('dispatch'), agent: z.string().optional(), task_type: z.string().optional() }),
  z.object({ kind: z.literal('session-reminder') }),
  z.object({ kind: z.literal('observation') }),
  z.object({
    kind: z.literal('task'),
    prompt: z.string().min(1),
    acceptance_criteria: z.string().optional(),
    expected_artifacts: z.array(ExpectedArtifactSchema).optional(),
    eligibility: EligibilitySchema.optional(),
    task_kind: TaskKindSchema.optional(),
    bounds: BoundsInputSchema.optional(),
    review_eligibility: EligibilitySchema.optional(),
    priority: TaskPrioritySchema.optional(),
    requires_review: z.boolean().optional(),
  }),
]);

export const RunBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('markdown-template'), template: z.string() }),
  z.object({ kind: z.literal('ts-function') }),
]);

export const WorkflowSpecSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase kebab-case'),
  description: z.string(),
  triggers: z.array(TriggerSchema).min(1),
  recall: z.array(RecallSourceSchema),
  recall_budget_tokens: z.number().int().positive().optional(),
  process_gates: z.array(ProcessGateNameSchema).optional(),
  output: z.array(OutputSinkSchema),
  run: RunBodySchema,
  capture: z.object({ stats_key: z.string().optional() }).optional(),
});

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type RecallSource = z.infer<typeof RecallSourceSchema>;
export type OutputSink = z.infer<typeof OutputSinkSchema>;
export type ProcessGateName = z.infer<typeof ProcessGateNameSchema>;
