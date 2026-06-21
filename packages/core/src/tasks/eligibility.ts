import { type Eligibility, TIER_ORDER } from "./schema.js";

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

interface EligibilityOpts {
  now?: number;
  cooldowns?: Map<string, Map<string, number>>;
  task_id?: string;
}

export function isEligible(
  agent: AgentDescriptor,
  eligibility: Eligibility,
  opts: EligibilityOpts = {},
): boolean {
  if (!matchesRequiredTags(agent, eligibility)) return false;
  if (!matchesTier(agent, eligibility)) return false;
  if (!matchesCost(agent, eligibility)) return false;
  if (!matchesAllowDeny(agent, eligibility)) return false;
  if (isOnCooldown(agent, opts)) return false;
  return true;
}

function matchesRequiredTags(agent: AgentDescriptor, eligibility: Eligibility): boolean {
  const requiredTags = eligibility.required_tags ?? [];
  if (requiredTags.length === 0) return true;
  const agentTags = new Set(agent.tags ?? []);
  return requiredTags.every((tag) => agentTags.has(tag));
}

function matchesTier(agent: AgentDescriptor, eligibility: Eligibility): boolean {
  if (eligibility.min_tier === undefined) return true;
  const minRank = tierRank(eligibility.min_tier);
  if (minRank === -1) return true;
  return tierRank(agent.tier) >= minRank;
}

function matchesCost(agent: AgentDescriptor, eligibility: Eligibility): boolean {
  if (eligibility.max_cost_cents === undefined) return true;
  const cost = agent.cost_cents_per_run ?? 0;
  return cost <= eligibility.max_cost_cents;
}

function matchesAllowDeny(agent: AgentDescriptor, eligibility: Eligibility): boolean {
  if ((eligibility.deny_agents ?? []).includes(agent.name)) return false;
  const allowAgents = eligibility.allow_agents ?? [];
  if (allowAgents.length > 0 && !allowAgents.includes(agent.name)) return false;
  return true;
}

function isOnCooldown(agent: AgentDescriptor, opts: EligibilityOpts): boolean {
  const taskId = opts.task_id;
  if (!taskId || !opts.cooldowns) return false;
  const now = opts.now ?? Date.now();
  const byAgent = opts.cooldowns.get(taskId);
  return !!byAgent && (byAgent.get(agent.name) ?? 0) > now;
}
