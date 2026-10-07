import type { WorkflowCtx } from "@penumbra/workflows";
import type { Database } from "bun:sqlite";

import {
  type AgentOutcome,
  type AgentTaskType,
  pickFromPool,
  readRoutingBiases,
  readSubscriptionPressure,
  resolveBiasEffect,
  resolveProvider,
  routeAgent,
  type RouteAgentInput,
  type RoutingBias,
} from "@penumbra/core";

export type AgentField = { kind: "single"; agent: string } | { kind: "pool"; agents: string[] };
const DEAD_PIN_CONSECUTIVE_FAILURES = 3;
export const DEAD_PIN_FAILURE_OUTCOMES: ReadonlySet<AgentOutcome> = new Set([
  "failed",
  "test_failed",
  "typecheck_failed",
  "pr_creation_failed",
  "rejected",
]);
export const DEAD_PIN_NON_FAILURE_OUTCOMES: ReadonlySet<AgentOutcome> = new Set([
  "pr_opened",
  "merged",
  "merged_with_concerns",
  "no_changes",
  "partial",
  "bypassed",
  "completed_with_output",
]);
const DEFAULT_DEAD_PIN_FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DEAD_PIN_FAILURE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEAD_PIN_FAILURE_WINDOW_ENV = "PENUMBRA_DEAD_PIN_FAILURE_WINDOW_MS";
type AgentPoolLike =
  | string
  | string[]
  | {
      members?: { agent?: unknown }[];
    };
type AgentPoolObject = { members?: { agent?: unknown }[] };

export function agentPoolToNames(pool: unknown): string[] {
  if (typeof pool === "string") return pool.length > 0 ? [pool] : [];
  if (Array.isArray(pool))
    return pool.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (!pool || typeof pool !== "object" || Array.isArray(pool)) return [];
  const members = (pool as AgentPoolObject).members;
  if (!Array.isArray(members)) return [];
  return members
    .map((member) => member.agent)
    .filter((agent): agent is string => typeof agent === "string" && agent.length > 0);
}

export function parseAgentField(raw: unknown): AgentField | null {
  const agents = agentPoolToNames(raw);
  const [agent] = agents;
  if (agents.length === 1 && typeof raw === "string" && agent) {
    return { kind: "single", agent };
  }
  if (agents.length > 0) return { kind: "pool", agents };
  return null;
}

function firstPoolAgent(pool: string[]): string {
  const [agent] = pool;
  if (!agent) throw new Error("resolveAgent: pool must not be empty");
  return agent;
}

function resolveDeadPinFailureWindowMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[DEAD_PIN_FAILURE_WINDOW_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_DEAD_PIN_FAILURE_WINDOW_MS;
  const parsed = parsePositiveIntegerEnv(raw);
  if (parsed === null) return DEFAULT_DEAD_PIN_FAILURE_WINDOW_MS;
  // Thirty days still covers unusually slow follow-up cycles, but prevents
  // stale history from acting like current liveness and keeps Date arithmetic representable.
  if (parsed > MAX_DEAD_PIN_FAILURE_WINDOW_MS) return DEFAULT_DEAD_PIN_FAILURE_WINDOW_MS;
  return parsed;
}

function parsePositiveIntegerEnv(raw: string): number | null {
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function isDeadPinFailureOutcome(outcome: string): boolean {
  return DEAD_PIN_FAILURE_OUTCOMES.has(outcome as AgentOutcome);
}

function hasRecentDeadPinFailures(db: Database, agent: string, taskType: string): boolean {
  try {
    const windowMs = resolveDeadPinFailureWindowMs();
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    // Wait timeouts are seat failures. Other cancels neither count toward nor
    // interrupt consecutive failures; the helper records timeouts before cancel.
    const rows = db
      .query<{ outcome: string }, [string, string, string, number]>(
        `SELECT ap.outcome
         FROM agent_performance ap
         LEFT JOIN handoffs h ON h.handoff_id = ap.handoff_id
         WHERE ap.agent_name = ? AND ap.task_type = ? AND ap.source IN ('worker','reconciler')
           AND (ap.environment_failure IS NULL OR ap.environment_failure != 'y')
           AND (h.cancel_requested_at IS NULL OR EXISTS (
             SELECT 1 FROM dispatch_events de WHERE de.handoff_id = ap.handoff_id
               AND de.source = 'workflow' AND de.kind = 'workflow.cancel.wait_timeout'
           ))
           AND ap.ts >= ?
         ORDER BY ap.ts DESC
         LIMIT ?`,
      )
      .all(agent, taskType, cutoff, DEAD_PIN_CONSECUTIVE_FAILURES);
    const hasRecentFailures =
      rows.length === DEAD_PIN_CONSECUTIVE_FAILURES &&
      rows.every((row) => isDeadPinFailureOutcome(row.outcome));
    if (hasRecentFailures) return true;

    const staleRows = db
      .query<{ outcome: string; ts: string }, [string, string, string, number]>(
        `SELECT ap.outcome, ap.ts
         FROM agent_performance ap
         LEFT JOIN handoffs h ON h.handoff_id = ap.handoff_id
         WHERE ap.agent_name = ? AND ap.task_type = ? AND ap.source IN ('worker','reconciler')
           AND (ap.environment_failure IS NULL OR ap.environment_failure != 'y')
           AND (h.cancel_requested_at IS NULL OR EXISTS (
             SELECT 1 FROM dispatch_events de WHERE de.handoff_id = ap.handoff_id
               AND de.source = 'workflow' AND de.kind = 'workflow.cancel.wait_timeout'
           ))
           AND ap.ts < ?
         ORDER BY ap.ts DESC
         LIMIT ?`,
      )
      .all(agent, taskType, cutoff, DEAD_PIN_CONSECUTIVE_FAILURES);
    const revived =
      staleRows.length === DEAD_PIN_CONSECUTIVE_FAILURES &&
      staleRows.every((row) => isDeadPinFailureOutcome(row.outcome));
    if (revived) {
      console.warn("[workflow-agent-resolver] dead pin revived", {
        agent,
        task_type: taskType,
        stale_failures: staleRows.length,
        newest_stale_failure_ts: staleRows[0]?.ts ?? null,
        window_ms: windowMs,
      });
    }
    return false;
  } catch {
    return false;
  }
}

export function resolveAgent(
  field: AgentField,
  taskType: string,
  ctx: WorkflowCtx,
  // tool_free: caller asserts the role contract is text-only (no penumbra
  // MCP tool calls, no commit/worktree). Forwarded to pickFromPool → routeAgent
  // so a fast HTTP seat outranks an equivalent slow-to-start ACP seat. Default
  // unset (false) keeps every existing caller byte-identical. ONLY set by
  // callers that have positively confirmed text-only behavior; routing a
  // tool-needing role to an HTTP seat breaks it.
  opts: { excludeAgents?: string[]; fallback_role?: string; tool_free?: boolean } = {},
): string {
  let pool: string[] | undefined;
  if (field.kind === "pool") {
    const excluded = new Set(opts.excludeAgents ?? []);
    const agents = field.agents.filter((agent) => !excluded.has(agent));
    pool = agents.length > 0 ? agents : field.agents;
  }

  const db = ctx.db?.();
  if (!db) return field.kind === "single" ? field.agent : firstPoolAgent(pool ?? field.agents);

  let activeBiases: RoutingBias[] | undefined;
  try {
    activeBiases = readRoutingBiases(db, { now: new Date() });
  } catch {
    activeBiases = undefined;
  }

  const agentchatConfig = {
    ...ctx.config,
    agents: Array.isArray(ctx.config.agents) ? ctx.config.agents : [],
  } as NonNullable<RouteAgentInput["agentchatConfig"]>;
  if (field.kind === "single") {
    const preferredConfig = agentchatConfig.agents.find((agent) => agent.name === field.agent);
    const provider = preferredConfig ? resolveProvider(preferredConfig) : null;
    const fallbackRole = opts.fallback_role;
    if (!fallbackRole) return field.agent;
    const biasExcluded = resolveBiasEffect(field.agent, provider, activeBiases).exclude;
    const deadPinExcluded = hasRecentDeadPinFailures(db, field.agent, taskType);
    const pinExcluded = biasExcluded || deadPinExcluded;
    if (!pinExcluded) return field.agent;

    const fallbackAgents = agentchatConfig.agents
      .filter((agent) => agent.name !== field.agent && agent.roles.includes(fallbackRole))
      .map((agent) => agent.name);
    if (fallbackAgents.length === 0) return field.agent;

    try {
      const pressure = readSubscriptionPressure(db);
      const out = routeAgent({
        db,
        detail: "rank",
        taskType: taskType as AgentTaskType,
        agentRegistry: fallbackAgents,
        includeNeutral: true,
        applyPressure: pressure,
        agentchatConfig: {
          ...agentchatConfig,
          role_routing: {
            ...agentchatConfig.role_routing,
            headroom_weighting: true,
            latency_weighting: true,
          },
        },
        tool_free: opts.tool_free,
        activeBiases,
      });
      if (out.detail === "rank") {
        const alternative = out.candidates.candidates[0]?.agent_name;
        if (alternative) return alternative;
      }
    } catch {
      // Preserve fallback behavior when pressure-aware routing cannot score candidates.
    }
    if (deadPinExcluded && !biasExcluded) return firstPoolAgent(fallbackAgents);
    return field.agent;
  }

  const pressure = readSubscriptionPressure(db);
  const poolAgents = pool ?? field.agents;
  return pickFromPool(
    poolAgents,
    db,
    agentchatConfig,
    pressure,
    taskType as AgentTaskType,
    opts.tool_free,
    activeBiases,
  );
}
