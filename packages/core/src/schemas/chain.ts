import { z } from 'zod';
import { AgentTaskTypeSchema } from './agent-performance.js';
import { SafeProjectIdSchema } from './project-id.js';
import { TaskClassSchema } from './task-class.js';

export const ChainStartRequestSchema = z.object({
  initial_agent: z.string().min(1),
  message: z.string().min(1),
  conversation_id: z.string().min(1).optional(),
  project_id: SafeProjectIdSchema.nullable().optional(),
  max_hops: z.number().int().positive().optional(),
  trust_mode: z.enum(['all', 'config']).optional(),
  use_worktree: z.preprocess(
    (v) => (v === 1 ? true : v === 0 ? false : v),
    z.boolean().nullable().optional(),
  ),
  parent_handoff_id: z.string().min(1).optional(),
  dispatch_kind: z.enum(['long_lived_tick']).optional(),
  long_lived_agent_id: z.string().min(1).optional(),
  long_lived_tick_id: z.string().min(1).optional(),
  branch_base: z.string().min(1).optional(),
  open_pr_on_review: z.boolean().optional(),
  task_type: AgentTaskTypeSchema.optional(),
  task_class: TaskClassSchema.optional(),
});
export type ChainStartRequest = z.infer<typeof ChainStartRequestSchema>;
