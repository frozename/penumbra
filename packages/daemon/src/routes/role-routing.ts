import { inferAgentTaskTypeForRole, routeAgent, type AgentTaskType, type RoleRoute, type Services } from '@penumbra/core';

/**
 * Resolve a role to a concrete agent via routeAgent's 'single' detail mode.
 * Returns null when no agentchat routing config is present, when the role
 * has no eligible agents, or when routeAgent declines to bind. Callers
 * decide their own fallback policy for the null result.
 */
export function resolveSingleRoute(
  services: Services,
  role: string,
  message: string,
  taskType?: AgentTaskType,
): RoleRoute | null {
  const agentRouting = services.agentRouting;
  if (!agentRouting) return null;
  const resolvedTaskType = taskType ?? inferAgentTaskTypeForRole(message, role);
  const out = routeAgent({
    db: services.db,
    detail: 'single',
    role,
    message,
    taskType: resolvedTaskType,
    agentRegistry: services.agentRegistry,
    agentchatConfig: { agents: agentRouting.agents },
    roleExplorationPolicy: agentRouting.role_exploration_policy,
    defaultRoles: agentRouting.default_roles,
    now: services.clock(),
  });
  return out.detail === 'single' ? out.route : null;
}
