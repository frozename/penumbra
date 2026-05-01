import type { Services } from '../services.js';
import { rankAgents } from '../readers/agent-rank.js';
import { inferAgentTaskTypeForRole, type AgentTaskType } from '../schemas/agent-performance.js';

export interface RoleRoute {
  agent: string;
  role: string;
  taskType: AgentTaskType;
}

export function resolveAgentForRole(opts: {
  services: Services;
  role: string;
  message: string;
  taskType?: AgentTaskType | null;
}): RoleRoute | null {
  const { agentRegistry, agentRouting } = opts.services;
  if (!agentRouting) return null;

  const roleAgents = agentRouting.agents
    .filter((agent) => agent.roles.includes(opts.role))
    .map((agent) => agent.name)
    .filter((name) => !agentRegistry || agentRegistry.includes(name));
  if (roleAgents.length === 0) return null;

  const taskType = opts.taskType ?? inferAgentTaskTypeForRole(opts.message, opts.role);
  const ranked = rankAgents(opts.services.db, {
    task_type: taskType,
    include_neutral: true,
    min_samples: 1,
    include_cost: false,
  }, opts.services.clock);

  const roleAgentSet = new Set(roleAgents);
  const sampledAgents = new Set(ranked.candidates.map((candidate) => candidate.agent_name));
  const defaultAgent = agentRouting.default_roles[opts.role];
  const unsampledAlternate = roleAgents.find((agent) => agent !== defaultAgent && !sampledAgents.has(agent));
  const unsampledAgent = roleAgents.find((agent) => !sampledAgents.has(agent));
  const rankedAgent = ranked.candidates.find((candidate) => roleAgentSet.has(candidate.agent_name));
  if (agentRouting.role_exploration_policy === 'ranked-first') {
    if (rankedAgent) {
      return { agent: rankedAgent.agent_name, role: opts.role, taskType };
    }
    if (defaultAgent && roleAgentSet.has(defaultAgent)) {
      return { agent: defaultAgent, role: opts.role, taskType };
    }
    if (unsampledAlternate) {
      return { agent: unsampledAlternate, role: opts.role, taskType };
    }
    if (unsampledAgent) {
      return { agent: unsampledAgent, role: opts.role, taskType };
    }
    return { agent: roleAgents[0]!, role: opts.role, taskType };
  }

  if (unsampledAlternate) {
    return { agent: unsampledAlternate, role: opts.role, taskType };
  }
  if (unsampledAgent) {
    return { agent: unsampledAgent, role: opts.role, taskType };
  }
  if (rankedAgent) {
    return { agent: rankedAgent.agent_name, role: opts.role, taskType };
  }

  if (defaultAgent && roleAgentSet.has(defaultAgent)) {
    return { agent: defaultAgent, role: opts.role, taskType };
  }
  return { agent: roleAgents[0]!, role: opts.role, taskType };
}
