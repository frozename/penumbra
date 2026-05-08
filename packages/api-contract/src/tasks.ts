import { z } from 'zod';

export const TaskStatusSchema = z.enum([
  'filed',
  'eligible',
  'leased',
  'completed',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskKindSchema = z.enum(['work', 'review', 'orchestrate']);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TasksListQuerySchema = z.object({
  status: TaskStatusSchema.optional(),
  kind: TaskKindSchema.optional(),
  eligible_for: z.string().min(1).optional(),
  parent_task_id: z.string().min(1).optional(),
  origin: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
}).strict();

// Server-side TaskRow shape evolves quickly; treat as loose snapshot.
export const TaskRowSchema = z.object({
  task_id: z.string(),
  kind: TaskKindSchema.nullable().optional(),
  status: TaskStatusSchema.nullable().optional(),
  prompt: z.string().nullable().optional(),
  origin: z.string().nullable().optional(),
  parent_task_id: z.string().nullable().optional(),
  created_at: z.union([z.string(), z.number()]).nullable().optional(),
}).loose();
export type TaskRow = z.infer<typeof TaskRowSchema>;

export const TasksListResponseSchema = z.object({
  tasks: z.array(TaskRowSchema),
});
