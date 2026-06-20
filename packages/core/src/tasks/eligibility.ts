import { TIER_ORDER, type Eligibility } from "./schema.js";

export { TIER_ORDER } from "./schema.js";

export type AgentDescriptor = {
  name: string;
  tags?: string[];
  tier?: string;
  cost_cents_per_run?: number;
  maestro_capable?: boolean;
};

function tierRank(tier: string | undefined): number {
  if (!tier) return -1;
  const idx = TIER_ORDER.indexOf(tier as (typeof TIER_ORDER)[number]);
  return idx === -1 ? -1 : idx;
}

export function isEligible(
  agent: AgentDescriptor,
  eligibility: Eligibility,
  opts: {
    now?: number;
    cooldowns?: Map<string, Map<string, number>>;
    task_id?: string;
  } = {},
): boolean {
  const requiredTags = eligibility.required_tags ?? [];
  if (requiredTags.length > 0) {
    const agentTags = new Set(agent.tags ?? []);
    if (requiredTags.some((tag) => !agentTags.has(tag))) return false;
  }

  if (eligibility.min_tier !== undefined) {
    const minRank = tierRank(eligibility.min_tier);
    if (minRank !== -1) {
      const agentRank = tierRank(agent.tier);
      if (agentRank < minRank) return false;
    }
  }

  if (eligibility.max_cost_cents !== undefined) {
    const cost = agent.cost_cents_per_run ?? 0;
    if (cost > eligibility.max_cost_cents) return false;
  }

  if ((eligibility.deny_agents ?? []).includes(agent.name)) return false;

  const allowAgents = eligibility.allow_agents ?? [];
  if (allowAgents.length > 0 && !allowAgents.includes(agent.name)) return false;

  const taskId = opts.task_id;
  if (taskId && opts.cooldowns) {
    const now = opts.now ?? Date.now();
    const byAgent = opts.cooldowns.get(taskId);
    if (byAgent && (byAgent.get(agent.name) ?? 0) > now) return false;
  }

  return true;
}
