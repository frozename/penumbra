import { z } from 'zod';

export const FileScope = z.enum(['new', 'modify-existing', 'extend-shared']);
export const TaskSize = z.enum(['small', 'substantial', 'risky']);
export const RiskClass = z.enum(['paste-ready', 'schema-aware', 'bootstrap-touching']);

const TaskIdSchema = z
  .union([z.string().min(1), z.number()])
  .transform((v) => String(v));

export const TaskMetaSchema = z.object({
  id: TaskIdSchema,
  files: z.array(z.string().min(1)),
  file_scope: FileScope,
  depends_on: z.array(TaskIdSchema),
  parallel_with: z.array(TaskIdSchema),
  preferred_agent: z.string().min(1),
  fallback_agent: z.string().min(1),
  task_size: TaskSize,
  risk_class: RiskClass,
});

export type TaskMeta = z.infer<typeof TaskMetaSchema>;
