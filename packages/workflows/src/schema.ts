import { z } from 'zod';

export const TriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slash'), command: z.string().min(1) }),
  z.object({ kind: z.literal('lifecycle'), event: z.enum(['session-start', 'pre-compact', 'stop', 'user-prompt-submit', 'post-tool-use']) }),
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
  z.object({ source: z.literal('memory.search'), args: ArgsRecord }),
  z.object({ source: z.literal('memory.timeline'), args: ArgsRecord }),
  z.object({ source: z.literal('memory.get_observations'), args: ArgsRecord }),
  z.object({ source: z.literal('git.log'), args: ArgsRecord }),
  z.object({ source: z.literal('git.diff'), args: ArgsRecord }),
  z.object({ source: z.literal('dispatch_events'), args: ArgsRecord }),
  z.object({ source: z.literal('handoff.list_pending'), args: ArgsRecord.optional() }),
  z.object({ source: z.literal('fs.glob'), args: ArgsRecord }),
  z.object({ source: z.literal('fs.grep'), args: ArgsRecord }),
  z.object({ source: z.literal('daemon.endpoint'), args: z.object({ path: z.string() }) }),
  z.object({
    source: z.literal('mcp.tool'),
    args: z.object({
      tool: z.string().min(1),
      input: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);

export const ProcessGateNameSchema = z.enum([
  'verification-before-complete',
  'tdd',
  'brainstorm-first',
  'worktree-isolation',
]);

export const OutputSinkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string() }),
  z.object({ kind: z.literal('clipboard') }),
  z.object({ kind: z.literal('next-session-prompt') }),
  z.object({ kind: z.literal('commit'), message: z.string() }),
  z.object({ kind: z.literal('dispatch'), agent: z.string().optional(), task_type: z.string().optional() }),
  z.object({ kind: z.literal('session-reminder') }),
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
