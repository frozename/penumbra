import type { Database } from "bun:sqlite";
import { z } from "zod";
import { WorkingMemorySchema } from "@penumbra/core/long-lived/types";

export const LongLivedGetArgsSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function handleLongLivedGet(db: Database, args: unknown) {
  const parsed = LongLivedGetArgsSchema.parse(args ?? {});
  const agent = db
    .query<
      {
        id: string;
        display_name: string;
        status: string;
        degraded_reason: string | null;
        consecutive_failures: number;
        circuit_breaker_threshold: number;
        schedule_cron: string | null;
        subscriptions_json: string | null;
        mcp_allowlist_json: string;
        approval_required_globs_json: string;
        cooldown_overrides_json: string;
        bounds_wall_clock_ms: number | null;
        bounds_cost_cents: number | null;
        bounds_max_sub_dispatches: number | null;
        working_memory_json: string;
        standing_brief: string;
        last_tick_started_at: number | null;
        last_tick_completed_at: number | null;
        last_tick_outcome: string | null;
        last_intent_summary: string | null;
        created_at: number;
        updated_at: number;
        retired_at: number | null;
      },
      [string]
    >(
      `SELECT id, display_name, status, degraded_reason, consecutive_failures, circuit_breaker_threshold,
            schedule_cron, subscriptions_json, mcp_allowlist_json, approval_required_globs_json,
            cooldown_overrides_json, bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches,
            working_memory_json, standing_brief, last_tick_started_at, last_tick_completed_at,
            last_tick_outcome, last_intent_summary, created_at, updated_at, retired_at
     FROM long_lived_agents
     WHERE id = ?
     LIMIT 1`,
    )
    .get(parsed.id);
  if (!agent) throw new Error("agent_not_found");

  const recentTicks = db
    .query<
      {
        id: string;
        agent_id: string;
        chain_id: string | null;
        trigger_kind: string;
        trigger_payload_json: string | null;
        intent_summary: string | null;
        started_at: number;
        completed_at: number | null;
        outcome: string | null;
        cost_cents: number | null;
        error_summary: string | null;
        working_memory_diff_json: string | null;
      },
      [string]
    >(
      `SELECT id, agent_id, chain_id, trigger_kind, trigger_payload_json, intent_summary, started_at,
            completed_at, outcome, cost_cents, error_summary, working_memory_diff_json
     FROM long_lived_ticks
     WHERE agent_id = ?
     ORDER BY started_at DESC
     LIMIT 20`,
    )
    .all(parsed.id)
    .map((row) => ({
      ...row,
      trigger_payload: parseJson<unknown>(row.trigger_payload_json),
      working_memory_diff: parseJson<unknown>(row.working_memory_diff_json),
    }));

  const pendingActions = db
    .query<
      {
        id: string;
        agent_id: string;
        tick_id: string;
        action_kind: string;
        action_target: string;
        payload_json: string;
        rationale: string | null;
        status: string;
        expires_at: number;
        decided_by: string | null;
        decided_at: number | null;
        executed_in_tick_id: string | null;
        created_at: number;
      },
      [string]
    >(
      `SELECT id, agent_id, tick_id, action_kind, action_target, payload_json, rationale,
            status, expires_at, decided_by, decided_at, executed_in_tick_id, created_at
     FROM long_lived_pending_actions
     WHERE agent_id = ?
     ORDER BY created_at DESC`,
    )
    .all(parsed.id)
    .map((row) => ({
      ...row,
      payload: parseJson<unknown>(row.payload_json),
    }));

  const recentAudit = db
    .query<
      {
        id: number;
        agent_id: string;
        tick_id: string | null;
        pending_action_id: string | null;
        action_kind: string;
        action_target: string;
        decision: string;
        reason: string | null;
        created_at: number;
      },
      [string]
    >(
      `SELECT id, agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at
     FROM long_lived_action_audit
     WHERE agent_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 50`,
    )
    .all(parsed.id);

  return {
    agent: {
      ...agent,
      subscriptions: parseJson<unknown>(agent.subscriptions_json),
      mcp_allowlist: parseJson<unknown>(agent.mcp_allowlist_json) ?? [],
      approval_required_globs: parseJson<unknown>(agent.approval_required_globs_json) ?? [],
      cooldown_overrides: parseJson<unknown>(agent.cooldown_overrides_json) ?? {},
      working_memory: WorkingMemorySchema.parse(JSON.parse(agent.working_memory_json)),
    },
    recent_ticks: recentTicks,
    pending_actions: pendingActions,
    recent_audit: recentAudit,
  };
}
