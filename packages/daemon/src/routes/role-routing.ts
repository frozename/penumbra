import {
  inferAgentTaskTypeForRole,
  readRoutingBiases,
  readSubscriptionPressure,
  routeAgent,
  type AgentRoutingConfig,
  type AgentTaskType,
  type RoleRoute,
  type Services,
} from "@penumbra/core";

type AgentRoutingWithRoleRouting = AgentRoutingConfig & {
  role_routing?: {
    headroom_weighting?: boolean;
    latency_weighting?: boolean;
    exploration_policy?: string;
  };
};

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
  const agentRoutingWithRoleRouting = agentRouting as AgentRoutingWithRoleRouting;
  const resolvedTaskType = taskType ?? inferAgentTaskTypeForRole(message, role);
  let pressure: ReturnType<typeof readSubscriptionPressure> | undefined;
  try {
    pressure = readSubscriptionPressure(services.db);
  } catch {}
  // User-driven usage-steering biases. Degrade to unsteered routing on any read
  // error, mirroring the pressure read above.
  let activeBiases: ReturnType<typeof readRoutingBiases> | undefined;
  try {
    activeBiases = readRoutingBiases(services.db, { now: services.clock() });
  } catch {}
  const out = routeAgent({
    db: services.db,
    detail: "single",
    role,
    message,
    taskType: resolvedTaskType,
    agentRegistry: services.agentRegistry,
    agentchatConfig: {
      agents: agentRouting.agents,
      role_routing: agentRoutingWithRoleRouting.role_routing,
    },
    roleExplorationPolicy: agentRouting.role_exploration_policy,
    defaultRoles: agentRouting.default_roles,
    applyPressure: pressure,
    activeBiases,
    now: services.clock(),
  });
  return out.detail === "single" ? out.route : null;
}
