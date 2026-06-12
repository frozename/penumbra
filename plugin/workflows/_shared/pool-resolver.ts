import { pickFromPool } from "../../../packages/core/src/tasks/pick-from-pool.js";
import { readSubscriptionPressure } from "../../../packages/core/src/readers/subscription-pressure.js";
import type { WorkflowCtx } from "@penumbra/workflows";

export type AgentField = { kind: "single"; agent: string } | { kind: "pool"; agents: string[] };

export function parseAgentField(raw: string | string[] | undefined): AgentField | null {
  if (typeof raw === "string" && raw.length > 0) return { kind: "single", agent: raw };
  if (Array.isArray(raw)) {
    const agents = raw.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (agents.length > 0) return { kind: "pool", agents };
  }
  return null;
}

export function resolveAgent(
  field: AgentField,
  taskType: string,
  ctx: WorkflowCtx,
  opts: { excludeAgents?: string[] } = {},
): string {
  if (field.kind === "single") return field.agent;

  const excluded = new Set(opts.excludeAgents ?? []);
  const agents = field.agents.filter((agent) => !excluded.has(agent));
  const pool = agents.length > 0 ? agents : field.agents;
  const db = ctx.db?.();
  if (!db) return pool[0]!;

  const pressure = readSubscriptionPressure(db);
  return pickFromPool(pool, db, ctx.config as any, pressure, taskType as any);
}
