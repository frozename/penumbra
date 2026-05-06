import { z } from 'zod';

export const PlanStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PlanTaskStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);
export type PlanTaskStatus = z.infer<typeof PlanTaskStatusSchema>;

export const PlanRecordSchema = z.object({
  plan_id: z.string().min(1),
  file_path: z.string().min(1),
  home_project: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/),
  registered_at: z.number().int().nonnegative(),
  status: PlanStatusSchema,
});
export type PlanRecord = z.infer<typeof PlanRecordSchema>;

export const PlanTaskRecordSchema = z.object({
  plan_id: z.string().min(1),
  task_meta_id: z.string().min(1),
  project_id: z.string().min(1),
  task_id_in_board: z.string().min(1).nullable(),
  status: PlanTaskStatusSchema,
  last_event_ts: z.number().int().nonnegative().nullable(),
});
export type PlanTaskRecord = z.infer<typeof PlanTaskRecordSchema>;
