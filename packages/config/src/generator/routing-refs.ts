import type { AgentPool } from "../files/agent-pool.js";
import type { AgentsConfig } from "../files/agents.js";
import type { RoutingConfig } from "../files/routing.js";

export interface RoutingAgentReference {
  path: string;
  agent: string;
}

function collectAgentPoolNames(pool: AgentPool | undefined): string[] {
  if (pool === undefined) return [];
  if (typeof pool === "string") return [pool];
  if (Array.isArray(pool)) return pool;
  return pool.members.map((member) => member.agent);
}

function collectRoutingAgentReferences(routing: RoutingConfig): RoutingAgentReference[] {
  const refs: RoutingAgentReference[] = [];

  for (const [role, agent] of Object.entries(routing.default_roles)) {
    refs.push({ path: `default_roles.${role}`, agent });
  }

  for (const [persona, config] of Object.entries(routing.personas ?? {})) {
    for (const agent of collectAgentPoolNames(config.preferred_agent)) {
      refs.push({ path: `personas.${persona}.preferred_agent`, agent });
    }
  }

  for (const [workload, config] of Object.entries(routing.workloads ?? {})) {
    if (!config?.synthesizer) continue;
    for (const agent of collectAgentPoolNames(config.synthesizer)) {
      refs.push({ path: `workloads.${workload}.synthesizer`, agent });
    }
  }

  return refs;
}

/** Routing references whose agent name is not present in `agents`. */
export function collectMissingRoutingAgents(
  agents: AgentsConfig,
  routing: RoutingConfig,
): RoutingAgentReference[] {
  const known = new Set(agents.agents.map((agent) => agent.name));
  return collectRoutingAgentReferences(routing).filter((ref) => !known.has(ref.agent));
}

/**
 * Hard-fails a generator prune plan when routing.yaml still references one
 * of the agent names it is about to remove — pruning must never silently
 * orphan a live routing reference.
 */
export function assertPruneSafe(candidatePrunes: readonly string[], routing: RoutingConfig): void {
  const pruning = new Set(candidatePrunes);
  const unsafe = collectRoutingAgentReferences(routing).filter((ref) => pruning.has(ref.agent));
  if (unsafe.length === 0) return;
  const detail = unsafe.map((ref) => `${ref.path} -> ${ref.agent}`).join(", ");
  throw new Error(`refusing to prune agent(s) still referenced by routing.yaml: ${detail}`);
}
