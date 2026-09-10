import { z } from "zod";

export const DispatchLandRequestSchema = z.object({
  handoff_id: z.string().min(1),
  commit_message: z.string().min(1).optional(),
  mode: z.enum(["squash", "ff", "gh"]).optional().default("squash"),
  delete_branch: z.boolean().optional().default(true),
  force: z.boolean().optional().default(false),
  reject_if_held: z.boolean().optional().default(false),
});
export type DispatchLandRequest = z.infer<typeof DispatchLandRequestSchema>;
export type DispatchLandRequestInput = z.input<typeof DispatchLandRequestSchema>;

export const DispatchLandTaskStatusSchema = z.enum(["queued", "running", "done", "failed"]);
export type DispatchLandTaskStatus = z.infer<typeof DispatchLandTaskStatusSchema>;

export const DispatchLandAcceptedSchema = z
  .object({
    ok: z.literal(true),
    task_id: z.string(),
    status: DispatchLandTaskStatusSchema,
  })
  .loose();
export type DispatchLandAccepted = z.infer<typeof DispatchLandAcceptedSchema>;

const DispatchLandTaskErrorSchema = z
  .object({
    code: z.string(),
  })
  .loose();
export type DispatchLandTaskError = z.infer<typeof DispatchLandTaskErrorSchema>;

const DispatchLandSuccessSchema = z
  .object({
    ok: z.literal(true),
    commit_sha: z.string(),
    message_subject: z.string(),
    branch_deleted: z.boolean(),
    pr_closed: z.boolean(),
    worktree_torn_down: z.boolean(),
    already_landed: z.boolean().optional(),
    pr_merged: z.boolean().optional(),
    pr_number: z.number().optional(),
  })
  .loose();
export type DispatchLandSuccess = z.infer<typeof DispatchLandSuccessSchema>;

export const DispatchLandTaskSchema = z
  .object({
    task_id: z.string(),
    handoff_id: z.string(),
    status: DispatchLandTaskStatusSchema,
    created_at: z.string(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    result: DispatchLandSuccessSchema.nullable(),
    error: DispatchLandTaskErrorSchema.nullable(),
  })
  .loose();
export type DispatchLandTask = z.infer<typeof DispatchLandTaskSchema>;
