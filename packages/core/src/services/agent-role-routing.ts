import type { Services } from '../services.js';
import { routeAgent } from './agent-routing.js';
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
  const taskType = opts.taskType ?? inferAgentTaskTypeForRole(opts.message, opts.role);
  const out = routeAgent({
    db: opts.services.db,
    detail: 'single',
    role: opts.role,
    taskType,
    message: opts.message,
    agentRegistry,
    agentchatConfig: { agents: agentRouting.agents },
    now: opts.services.clock(),
  });
  if (out.detail !== 'single') {
    throw new Error('unexpected routeAgent detail for resolveAgentForRole');
  }
  return out.route;
}
