import { pickFromPool } from "../../../packages/core/src/tasks/pick-from-pool.js";
import {
  resolveBiasEffect,
  resolveProvider,
  routeAgent,
  type RouteAgentInput,
} from "../../../packages/core/src/services/agent-routing.js";
import {
  readRoutingBiases,
  type RoutingBias,
} from "../../../packages/core/src/readers/routing-bias.js";
import { readSubscriptionPressure } from "../../../packages/core/src/readers/subscription-pressure.js";
import type { WorkflowCtx } from "@penumbra/workflows";
import type { Database } from "bun:sqlite";

export type AgentField = { kind: "single"; agent: string } | { kind: "pool"; agents: string[] };
const DEAD_PIN_CONSECUTIVE_FAILURES = 3;
type AgentPoolLike =
  | string
  | string[]
  | {
      members?: Array<{ agent?: unknown }>;
    };

export function agentPoolToNames(pool: unknown): string[] {
  if (typeof pool === "string") return pool.length > 0 ? [pool] : [];
  if (Array.isArray(pool))
    return pool.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (!pool || typeof pool !== "object" || Array.isArray(pool)) return [];
  const members = (pool as AgentPoolLike).members;
  if (!Array.isArray(members)) return [];
  return members
    .map((member) => member.agent)
    .filter((agent): agent is string => typeof agent === "string" && agent.length > 0);
}

export function parseAgentField(raw: unknown): AgentField | null {
  const agents = agentPoolToNames(raw);
  if (agents.length === 1 && typeof raw === "string") return { kind: "single", agent: agents[0]! };
  if (agents.length > 0) return { kind: "pool", agents };
  return null;
}

function hasRecentDeadPinFailures(db: Database, agent: string, taskType: string): boolean {
  try {
    const rows = db
      .query<{ outcome: string }, [string, string, number]>(
        `SELECT outcome
         FROM agent_performance
         WHERE agent_name = ? AND task_type = ? AND source = 'worker'
           AND (environment_failure IS NULL OR environment_failure != 'y')
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(agent, taskType, DEAD_PIN_CONSECUTIVE_FAILURES);
    return (
      rows.length === DEAD_PIN_CONSECUTIVE_FAILURES && rows.every((row) => row.outcome === "failed")
    );
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
  if (!db) return field.kind === "single" ? field.agent : pool![0]!;

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
        taskType: taskType as RouteAgentInput["taskType"],
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
    } catch {}
    if (deadPinExcluded && !biasExcluded) return fallbackAgents[0]!;
    return field.agent;
  }

  const pressure = readSubscriptionPressure(db);
  return pickFromPool(
    pool!,
    db,
    ctx.config as any,
    pressure,
    taskType as any,
    opts.tool_free,
    activeBiases,
  );
}
