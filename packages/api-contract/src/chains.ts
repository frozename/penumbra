import { z } from "zod";

import { AgentTaskTypeSchema } from "./agent-performance.js";
import { HandoffStatusSchema } from "./handoffs.js";
import { TaskClassSchema } from "./lanes.js";
import { SafeProjectIdSchema } from "./project-id.js";

export const ChainsListQuerySchema = z
  .object({
    status: HandoffStatusSchema.optional(),
    project_id: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();
export type ChainsListQuery = z.infer<typeof ChainsListQuerySchema>;

export const ChainSummarySchema = z
  .object({
    conversation_id: z.string(),
    project_id: z.string().nullable(),
    latest_status: HandoffStatusSchema,
    latest_ts: z.string(),
    earliest_ts: z.string(),
    handoff_count: z.number().int().nonnegative(),
    root_handoff_id: z.string().nullable(),
    worktree_path: z.string().nullable().optional(),
    worktree_root: z.string().nullable().optional(),
    to_agent: z.string().nullable(),
    to_role: z.string().nullable(),
  })
  .loose();
export type ChainSummary = z.infer<typeof ChainSummarySchema>;

export const ChainsListResponseSchema = z.object({
  chains: z.array(ChainSummarySchema),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export const ChainResponseEventSchema = z
  .object({
    agent: z.string(),
    text: z.string(),
    ts: z.string(),
    handoff_id: z.string().nullable().optional(),
    error: z.object({ message: z.string() }).optional(),
  })
  .loose();

export const ChainResponsesPayloadSchema = z.object({
  responses: z.array(ChainResponseEventSchema),
});

export const ChainTerminatedEventSchema = z
  .object({
    ts: z.string(),
    reason: z.string().nullable(),
    hop_count: z.number().int().nullable(),
    terminal_handoff_id: z.string().nullable().optional(),
    conversation_id: z.string(),
  })
  .loose();

export const ChainHistoryResponseSchema = z.object({
  history: z.array(ChainTerminatedEventSchema),
});

export const ChainRoutingWarningSchema = z
  .object({
    code: z.literal("prompt_project_mismatch"),
    project_id: z.string(),
    mentioned_paths: z.array(z.string()),
    missing_in_project: z.array(z.string()),
    suggested_project_id: z.string().optional(),
    hint: z.string(),
  })
  .strict();
export type ChainRoutingWarning = z.infer<typeof ChainRoutingWarningSchema>;

export const ChainRoutingAdvisorySchema = z.discriminatedUnion("code", [
  z
    .object({
      code: z.literal("project_registry_unavailable"),
    })
    .strict(),
  z
    .object({
      code: z.literal("unknown_project_id_dropped"),
      project_id: z.string(),
      known_project_ids: z.array(z.string()),
    })
    .strict(),
]);
export type ChainRoutingAdvisory = z.infer<typeof ChainRoutingAdvisorySchema>;

const BranchTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,19}$/)
  .refine((value) => value !== "agent", {
    message: "branch_type 'agent' is reserved for legacy handoff branches",
  });

export const ChainStartRequestSchema = z.object({
  initial_agent: z.string().min(1),
  message: z.string().min(1),
  task_name: z.string().min(1).max(120).optional(),
  branch_type: BranchTypeSchema.optional(),
  conversation_id: z.string().min(1).optional(),
  project_id: SafeProjectIdSchema.nullable().optional(),
  max_hops: z.number().int().positive().optional(),
  trust_mode: z.enum(["all", "config"]).optional(),
  use_worktree: z.preprocess(
    (v) => (v === 1 ? true : v === 0 ? false : v),
    z.boolean().nullable().optional(),
  ),
  parent_handoff_id: z.string().min(1).optional(),
  dispatch_kind: z
    .enum(["long_lived_tick", "workflow", "thought_analyzer", "orchestrate"])
    .optional(),
  workflow_run_id: z.string().min(1).optional(),
  long_lived_agent_id: z.string().min(1).optional(),
  long_lived_tick_id: z.string().min(1).optional(),
  branch_base: z.string().min(1).optional(),
  open_pr_on_review: z.boolean().optional(),
  task_type: AgentTaskTypeSchema.optional(),
  task_class: TaskClassSchema.optional(),
  tool_free: z.boolean().optional(),
  isolated_install: z.boolean().optional(),
});
export type ChainStartRequest = z.infer<typeof ChainStartRequestSchema>;

export const ChainStartResponseSchema = z
  .object({
    conversation_id: z.string(),
    handoff_id: z.string(),
    branch_name: z.string().nullable().optional(),
    task_class: z.string().optional(),
    lane_id: z.string().nullable().optional(),
    recalled_memory_ids: z.array(z.string()).optional(),
    recalled_memories: z
      .array(
        z
          .object({
            id: z.string(),
            title: z.string(),
            obs_type: z.string(),
            snippet_head: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    routed_agent: z.string().optional(),
    routed_role: z.string().nullable().optional(),
    requested_agent: z.string().optional(),
    resolved_agent: z.string().optional(),
    routing_resolution_reason: z.string().optional(),
    routing_task_type: z.string().nullable().optional(),
    routing_warning: ChainRoutingWarningSchema.optional(),
    routing_advisory: ChainRoutingAdvisorySchema.optional(),
  })
  .loose();
export type ChainStartResponse = z.infer<typeof ChainStartResponseSchema>;
