import type { Database } from "bun:sqlite";
import type { AgentTaskType } from "../schemas/agent-performance.js";
import { routeAgent, type RouteAgentInput } from "../services/agent-routing.js";
import { pickPreferred } from "./auction.js";

type AgentchatConfig = NonNullable<RouteAgentInput["agentchatConfig"]>;
type PressureSnapshot = NonNullable<RouteAgentInput["applyPressure"]>;

export function pickFromPool(
  pool: string[],
  db: Database,
  agentchatConfig: AgentchatConfig | null | undefined,
  pressure: PressureSnapshot | null | undefined,
  taskType: AgentTaskType,
): string {
  if (pool.length === 0) throw new Error("pickFromPool: pool must not be empty");
  if (pool.length === 1) return pool[0]!;

  const localConfig: AgentchatConfig | undefined = agentchatConfig
    ? {
        ...agentchatConfig,
        role_routing: {
          ...agentchatConfig.role_routing,
          headroom_weighting: true,
        },
      }
    : undefined;

  const out = routeAgent({
    db,
    detail: "rank",
    taskType,
    agentRegistry: pool,
    includeNeutral: true,
    applyPressure: pressure ?? undefined,
    agentchatConfig: localConfig,
  });

  if (out.detail !== "rank") return pool[0]!;

  const winner = pickPreferred(
    out.candidates.candidates,
    pool.map((name) => ({ name })),
  );
  return winner?.agent_id ?? pool[0]!;
}
