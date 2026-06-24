import { pickFromPool } from "../../../packages/core/src/tasks/pick-from-pool.js";
import { readSubscriptionPressure } from "../../../packages/core/src/readers/subscription-pressure.js";
import type { WorkflowCtx } from "@penumbra/workflows";

export type AgentField = { kind: "single"; agent: string } | { kind: "pool"; agents: string[] };
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
  opts: { excludeAgents?: string[]; tool_free?: boolean } = {},
): string {
  if (field.kind === "single") return field.agent;

  const excluded = new Set(opts.excludeAgents ?? []);
  const agents = field.agents.filter((agent) => !excluded.has(agent));
  const pool = agents.length > 0 ? agents : field.agents;
  const db = ctx.db?.();
  if (!db) return pool[0]!;

  const pressure = readSubscriptionPressure(db);
  return pickFromPool(pool, db, ctx.config as any, pressure, taskType as any, opts.tool_free);
}
