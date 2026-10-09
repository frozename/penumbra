import { PermissionProfileSchema } from "@penumbra/api-contract";
import { z } from "zod";

import { AgentTaskTypeSchema } from "./agent-performance.js";
import { SafeProjectIdSchema } from "./project-id.js";

export { type ApproveHandoffRequest, ApproveHandoffRequestSchema } from "@penumbra/api-contract";

export const HandoffStatusSchema = z.enum([
  "pending",
  "approved",
  "redirected",
  "rejected",
  "dispatched",
  "completed",
  "failed",
  "expired",
]);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

export const HandoffRowSchema = z.object({
  handoff_id: z.string(),
  ts: z.string(),
  project_id: SafeProjectIdSchema.nullable(),
  conversation_id: z.string(),
  from_agent: z.string(),
  to_agent: z.string(),
  to_role: z.string().nullable(),
  requested_agent: z.string().nullable().optional(),
  routing_resolution_reason: z.string().nullable().optional(),
  message: z.string(),
  status: HandoffStatusSchema,
  resolved_by: z.string().nullable(),
  resolved_at: z.string().nullable(),
  redirected_to: z.string().nullable(),
  resolution_reason: z.string().nullable(),
  triggered_by_event_id: z.string().nullable(),
  chain_max_hops: z.number().int().nullable(),
  chain_trust_mode: z.enum(["all", "config"]).nullable(),
  chain_task_type: AgentTaskTypeSchema.nullable(),
  dispatch_kind: z
    .enum(["long_lived_tick", "workflow", "thought_analyzer", "orchestrate"])
    .nullable()
    .optional(),
  long_lived_agent_id: z.string().nullable().optional(),
  long_lived_tick_id: z.string().nullable().optional(),
  use_worktree: z.preprocess((v) => (v === 1 ? true : v === 0 ? false : v), z.boolean().nullable()),
  isolated_install: z.preprocess(
    (v) => (v === 1 ? true : v === 0 ? false : v),
    z.boolean().nullable().optional(),
  ),
  open_pr_on_review: z.preprocess(
    (v) => (v === 1 ? true : v === 0 ? false : v),
    z.boolean().nullable().optional(),
  ),
  branch_base: z.string().nullable().optional(),
  branch_name: z.string().nullable().optional(),
  error_message: z.string().nullable(),
  cancel_requested_at: z.string().nullable(),
  worker_id: z.string().nullable(),
  parent_handoff_id: z.string().nullable(),
  dispatch_attempts: z.number().int().nonnegative().default(0),
  max_dispatch_attempts: z.number().int().positive().default(3),
  last_dispatch_started_at: z.string().nullable().optional(),
  workflow_run_id: z.string().nullable().optional(),
  permission_profile: PermissionProfileSchema.nullable().optional(),
  caller_cwd: z.string().nullable().optional(),
  cwd_override: z.string().nullable().optional(),
});
export type HandoffRow = z.infer<typeof HandoffRowSchema>;

export const CreateHandoffRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  to_role: z.string().nullable().optional(),
  message: z.string().min(1),
  conversation_id: z.string().min(1),
  project_id: SafeProjectIdSchema.nullable().optional(),
  triggered_by_event_id: z.string().min(1),
  use_worktree: z.preprocess(
    (v) => (v === 1 ? true : v === 0 ? false : v),
    z.boolean().nullable().optional(),
  ),
  isolated_install: z.preprocess(
    (v) => (v === 1 ? true : v === 0 ? false : v),
    z.boolean().nullable().optional(),
  ),
  open_pr_on_review: z.preprocess(
    (v) => (v === 1 ? true : v === 0 ? false : v),
    z.boolean().optional(),
  ),
  chain_task_type: AgentTaskTypeSchema.nullable().optional(),
  chain_max_hops: z.number().int().positive().nullable().optional(),
  parent_handoff_id: z.string().min(1).nullable().optional(),
  branch_base: z.string().min(1).nullable().optional(),
  branch_name: z.string().min(1).optional(),
  permission_profile: PermissionProfileSchema.nullable().optional(),
  caller_cwd: z.string().min(1).nullable().optional(),
  // Chain hops inherit this from the parent row; a hop that sets a different
  // scratch root than its parent's is rejected at chain_start.
  cwd_override: z.string().min(1).nullable().optional(),
});
export type CreateHandoffRequest = z.infer<typeof CreateHandoffRequestSchema>;
