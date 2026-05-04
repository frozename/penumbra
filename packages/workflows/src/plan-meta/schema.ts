import { z } from 'zod';

export const FileScope = z.enum(['new', 'modify-existing', 'extend-shared']);
export const TaskSize = z.enum(['small', 'substantial', 'risky']);
export const RiskClass = z.enum(['paste-ready', 'schema-aware', 'bootstrap-touching']);

export const TaskMetaSchema = z.object({
  id: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
  file_scope: FileScope,
  depends_on: z.array(z.string()),
  parallel_with: z.array(z.string()),
  preferred_agent: z.string().min(1),
  fallback_agent: z.string().min(1),
  task_size: TaskSize,
  risk_class: RiskClass,
});

export type TaskMeta = z.infer<typeof TaskMetaSchema>;
