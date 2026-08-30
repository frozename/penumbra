import type { AgentPool } from "../files/agent-pool.js";
import type { AgentsConfig } from "../files/agents.js";
import type { RoutingConfig } from "../files/routing.js";
import type { Workload } from "../files/workload.js";

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

  const workloads = Object.entries(routing.workloads ?? {});
  for (const [workload, config] of workloads) {
    collectWorkloadReferences(refs, workload, config);
  }

  return refs;
}

function collectWorkloadReferences(
  refs: RoutingAgentReference[],
  workload: string,
  config: Workload | undefined,
): void {
  if (!config) return;
  if (config.synthesizer) {
    for (const agent of collectAgentPoolNames(config.synthesizer)) {
      refs.push({ path: `workloads.${workload}.synthesizer`, agent });
    }
  }
  for (const agent of config.eligible_agents ?? []) {
    refs.push({ path: `workloads.${workload}.eligible_agents`, agent });
  }
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
