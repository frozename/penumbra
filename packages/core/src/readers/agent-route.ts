import type { Database } from 'bun:sqlite';
import { routeAgent } from '../services/agent-routing.js';

export type AgentRoutePressureSnapshot = {
  snapshots: Array<{
    provider: string;
    window_label: string;
    model: string | null;
    used_pct: number;
    resets_at: number | null;
    observed_at: string;
    source_kind: string;
  }>;
  warnings?: unknown[];
};

export type AgentRouteAgentchatConfig = {
  agents: Array<{
    name: string;
    roles: string[];
    subscription_provider?: string;
    api_provider?: string;
    pricing_mode?: 'api' | 'subscription';
  }>;
};

export type AgentRouteForInput = {
  db: Database;
  role: string;
  windowDays?: number;
  minSamples?: number;
  agentKind?: 'coding' | 'long_lived';
  pressureSnapshot?: AgentRoutePressureSnapshot;
  agentchatRoles: AgentRouteAgentchatConfig;
};

export type AgentRouteChosen = {
  agent: string;
  success_rate: number;
  samples: number;
  roles: string[];
};

export type AgentRouteRejectedReason = 'no_role_match' | 'under_pressure' | 'below_min_samples' | 'lower_success_rate';

export type AgentRouteRejected = {
  agent: string;
  reason: AgentRouteRejectedReason;
  details?: string;
};

export type AgentRouteForOutput = {
  chosen: AgentRouteChosen | null;
  rejected: AgentRouteRejected[];
  reason: string;
};

function resolveProvider(agent: AgentRouteAgentchatConfig['agents'][number]): string | null {
  if (agent.pricing_mode === 'subscription') return agent.subscription_provider ?? null;
  return agent.api_provider ?? agent.subscription_provider ?? null;
}

function isOverPressure(provider: string, pressureSnapshot?: AgentRoutePressureSnapshot): boolean {
  if (!pressureSnapshot) return false;
  return pressureSnapshot.snapshots.some((snapshot) => snapshot.provider === provider && (snapshot.used_pct >= 0.9 || snapshot.source_kind === 'cooldown'));
}

export function routeForRole(input: AgentRouteForInput): AgentRouteForOutput {
  const minSamples = input.minSamples ?? 3;
  const routeSummary = routeAgent({
    db: input.db,
    detail: 'summary',
    taskType: input.role as any,
    windowDays: input.windowDays,
    agentKind: input.agentKind,
  });
  if (routeSummary.detail !== 'summary') {
    throw new Error('unexpected routeAgent detail for routeForRole');
  }
  const recommendations = routeSummary.recommendations;

  const byAgent = new Map(input.agentchatRoles.agents.map(agent => [agent.name, agent] as const));
  const rejected: AgentRouteRejected[] = [];
  const roleMatches = input.agentchatRoles.agents.filter(agent => agent.roles.includes(input.role));
  const rankedRoleMatches = recommendations.filter((rec) => byAgent.has(rec.agent_name) && byAgent.get(rec.agent_name)!.roles.includes(input.role));

  for (const agent of input.agentchatRoles.agents) {
    if (!agent.roles.includes(input.role)) {
      rejected.push({ agent: agent.name, reason: 'no_role_match' });
      continue;
    }

    const provider = resolveProvider(agent);
    if (provider && isOverPressure(provider, input.pressureSnapshot)) {
      rejected.push({ agent: agent.name, reason: 'under_pressure', details: provider });
      continue;
    }

    const recommendation = recommendations.find((rec) => rec.agent_name === agent.name);
    if (!recommendation || recommendation.samples < minSamples) {
      rejected.push({
        agent: agent.name,
        reason: 'below_min_samples',
        details: String(recommendation?.samples ?? 0),
      });
      continue;
    }
  }

  const eligible = rankedRoleMatches.filter((rec) => {
    const agent = byAgent.get(rec.agent_name);
    if (!agent) return false;
    const provider = resolveProvider(agent);
    if (provider && isOverPressure(provider, input.pressureSnapshot)) return false;
    return rec.samples >= minSamples;
  });

  const chosenRec = eligible[0] ?? null;
  const chosen = chosenRec ? {
    agent: chosenRec.agent_name,
    success_rate: chosenRec.success_rate,
    samples: chosenRec.samples,
    roles: byAgent.get(chosenRec.agent_name)?.roles ?? [],
  } : null;

  if (!chosen) {
    const filteredOut = roleMatches.length - eligible.length;
    return {
      chosen: null,
      rejected,
      reason: `no eligible agent — ${filteredOut} filtered out by role, ${rejected.filter((r) => r.reason === 'under_pressure').length} by pressure, ${rejected.filter((r) => r.reason === 'below_min_samples').length} by min_samples`,
    };
  }

  for (const rec of eligible.slice(1)) {
    rejected.push({
      agent: rec.agent_name,
      reason: 'lower_success_rate',
      details: `${rec.success_rate}`,
    });
  }

  return {
    chosen,
    rejected,
    reason: `chose ${chosen.agent} (success_rate ${chosen.success_rate}, ${chosen.samples} samples) over ${Math.max(0, eligible.length - 1)} other role-matching agents`,
  };
}
