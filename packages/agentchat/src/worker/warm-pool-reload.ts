import type { AgentConfig } from "../config/types.js";

export function invalidateChangedWarmPools(
  previousAgents: readonly AgentConfig[],
  nextAgents: readonly AgentConfig[],
  drainAgent: (agent: string) => void,
): void {
  const previousWarm = new Map<string, string>();
  for (const agent of previousAgents) {
    if (isWarm(agent)) previousWarm.set(agent.name, stableJson(agent));
  }

  for (const agent of nextAgents) {
    const previousConfig = previousWarm.get(agent.name);
    if (previousConfig === undefined) continue;
    previousWarm.delete(agent.name);
    if (!isWarm(agent) || previousConfig !== stableJson(agent)) drainAgent(agent.name);
  }

  for (const agent of previousWarm.keys()) drainAgent(agent);
}

function isWarm(agent: AgentConfig): boolean {
  return (agent.options as Record<string, unknown>).warm_pool === true;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
