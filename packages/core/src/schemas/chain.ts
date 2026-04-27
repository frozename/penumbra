import { z } from 'zod';
import { SafeProjectIdSchema } from './project-id.js';

export const ChainStartRequestSchema = z.object({
  initial_agent: z.string().min(1),
  message: z.string().min(1),
  conversation_id: z.string().min(1).optional(),
  project_id: SafeProjectIdSchema.nullable().optional(),
  max_hops: z.number().int().positive().optional(),
  trust_mode: z.enum(['all', 'config']).optional(),
  use_worktree: z.boolean().optional(),
});
export type ChainStartRequest = z.infer<typeof ChainStartRequestSchema>;