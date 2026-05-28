import type { AgentDescriptor } from "@penumbra/core";
import type { AgentChatConfig } from "./config/types.js";

export function getAgentDescriptor(
  name: string,
  cfg: AgentChatConfig,
): AgentDescriptor | undefined {
  const agent = cfg.agents.find((entry) => entry.name === name);
  if (!agent) return undefined;
  return {
    name: agent.name,
    tags: agent.tags,
    tier: agent.tier,
    cost_cents_per_run: agent.cost_cents_per_run,
    maestro_capable: agent.maestro_capable ?? false,
  };
}
