import { z } from "zod";

export const FileScope = z.enum(["new", "modify-existing", "extend-shared"]);
export const TaskSize = z.enum(["small", "substantial", "risky"]);
export const RiskClass = z.enum(["paste-ready", "schema-aware", "bootstrap-touching"]);

const TaskIdSchema = z.union([z.string().min(1), z.number()]).transform((v) => String(v));

const QualifiedTaskIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*\/[\d.]+$/);
const BareTaskIdSchema = z.string().regex(/^[\d.]+$/);

export const TaskMetaSchema = z.object({
  id: TaskIdSchema,
  files: z.array(z.string().min(1)),
  file_scope: FileScope,
  project: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_-]*$/)
    .optional(),
  depends_on: z.array(z.union([BareTaskIdSchema, QualifiedTaskIdSchema])),
  parallel_with: z.array(TaskIdSchema),
  preferred_agent: z.string().min(1),
  fallback_agent: z.string().min(1),
  task_size: TaskSize,
  risk_class: RiskClass,
  heading: z.string().optional(),
  body: z.string().optional(),
});

export type TaskMeta = z.infer<typeof TaskMetaSchema>;

export const PlanHeaderSchema = z.object({
  plan_id: z.string().min(1),
  home_project: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_-]*$/),
  plan_defaults: z
    .object({
      bounds: z
        .object({
          wall_clock_ms: z.number().int().positive().optional(),
          cost_cents: z.number().int().nonnegative().optional(),
          max_sub_dispatches: z.number().int().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type PlanHeader = z.infer<typeof PlanHeaderSchema>;
