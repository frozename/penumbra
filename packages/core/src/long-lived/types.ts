import { z } from "zod";

export const PendingGoalSchema = z.union([
  z.object({
    kind: z.literal("user_goal"),
    text: z.string().optional(),
  }),
  z.object({
    kind: z.literal("approved_action"),
    pending_action_id: z.string(),
    original_payload: z.unknown(),
  }),
]);

export const WorkingMemorySchema = z
  .object({
    version: z.literal(1),
    updated_at: z.number(),
    pending_goals: z.array(PendingGoalSchema),
    open_threads: z.array(
      z.object({
        id: z.string(),
        topic: z.string(),
        opened_at: z.number(),
        notes: z.string(),
      }),
    ),
    watches: z.array(
      z.object({
        id: z.string(),
        subject: z.string(),
        until: z.number().optional(),
        reason: z.string(),
      }),
    ),
    recent_decisions: z.array(
      z.object({
        pending_action_id: z.string(),
        decision: z.enum(["approved", "rejected", "expired"]),
        reason: z.string().optional(),
        decided_at: z.number(),
      }),
    ),
  })
  .passthrough();

export type WorkingMemory = z.infer<typeof WorkingMemorySchema>;

export const AgentStatusSchema = z.enum(["active", "paused", "degraded", "retired"]);
export const TickOutcomeSchema = z.enum(["success", "failed", "bound_exceeded", "circuit_open"]);
export const TriggerKindSchema = z.enum(["cron", "event", "injected_goal", "manual"]);
export const PendingActionStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);

export const LongLivedAgentRowSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  project_id: z.string().nullable().optional(),
  status: AgentStatusSchema,
  degraded_reason: z.string().nullable().optional(),
  consecutive_failures: z.number().int().nonnegative(),
  circuit_breaker_threshold: z.number().int().positive(),
  schedule_cron: z.string().nullable().optional(),
  subscriptions_json: z.string().nullable().optional(),
  mcp_allowlist_json: z.string(),
  approval_required_globs_json: z.string(),
  cooldown_overrides_json: z.string(),
  bounds_wall_clock_ms: z.number().int().positive().nullable().optional(),
  bounds_cost_cents: z.number().int().nonnegative().nullable().optional(),
  bounds_max_sub_dispatches: z.number().int().nonnegative().nullable().optional(),
  working_memory_json: z.string(),
  standing_brief: z.string(),
  last_tick_started_at: z.number().nullable().optional(),
  last_tick_completed_at: z.number().nullable().optional(),
  last_tick_outcome: TickOutcomeSchema.nullable().optional(),
  last_intent_summary: z.string().nullable().optional(),
  created_at: z.number(),
  updated_at: z.number(),
  retired_at: z.number().nullable().optional(),
});

export const LongLivedTickRowSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  chain_id: z.string().nullable().optional(),
  trigger_kind: TriggerKindSchema,
  trigger_payload_json: z.string().nullable().optional(),
  intent_summary: z.string().nullable().optional(),
  started_at: z.number(),
  completed_at: z.number().nullable().optional(),
  outcome: TickOutcomeSchema.nullable().optional(),
  cost_cents: z.number().int().nonnegative().nullable().optional(),
  error_summary: z.string().nullable().optional(),
  working_memory_diff_json: z.string().nullable().optional(),
});

export const LongLivedPendingActionRowSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  tick_id: z.string(),
  action_kind: z.string(),
  action_target: z.string(),
  payload_json: z.string(),
  rationale: z.string().nullable().optional(),
  status: PendingActionStatusSchema,
  expires_at: z.number(),
  decided_by: z.string().nullable().optional(),
  decided_at: z.number().nullable().optional(),
  executed_in_tick_id: z.string().nullable().optional(),
  created_at: z.number(),
});
