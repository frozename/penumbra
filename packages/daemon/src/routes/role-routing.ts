import {
  type AgentRoutingConfig,
  type AgentTaskType,
  inferAgentTaskTypeForRole,
  readRoutingBiases,
  readSubscriptionPressure,
  type RoleRoute,
  routeAgent,
  type Services,
} from "@penumbra/core";

type AgentRoutingWithRoleRouting = AgentRoutingConfig & {
  role_routing?: {
    headroom_weighting?: boolean;
    latency_weighting?: boolean;
    local_seat_health_gate?: boolean;
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
    pressure = readSubscriptionPressure(services.db, { now: services.clock });
  } catch {
    // degrade gracefully
  }
  // User-driven usage-steering biases. Degrade to unsteered routing on any read
  // error, mirroring the pressure read above.
  let activeBiases: ReturnType<typeof readRoutingBiases> | undefined;
  try {
    activeBiases = readRoutingBiases(services.db, { now: services.clock() });
  } catch {
    // degrade gracefully
  }
  let unhealthyAgents: ReadonlySet<string> | undefined;
  try {
    unhealthyAgents = services.localSeatHealth?.getUnhealthyAgents();
  } catch {
    // degrade gracefully
  }
  const out = routeAgent({
    db: services.db,
    detail: "single",
    role,
    message,
    taskType: resolvedTaskType,
    agentRegistry: services.agentRegistry,
    agentchatConfig: {
      // agentRouting.agents already carries adapter via
      // loadAgentRoutingFromConfig, so the scorer can apply the tool-free
      // penalty for callers that set tool_free:true on RouteAgentInput.
      agents: agentRouting.agents,
      role_routing: agentRoutingWithRoleRouting.role_routing,
    },
    roleExplorationPolicy: agentRouting.role_exploration_policy,
    defaultRoles: agentRouting.default_roles,
    applyPressure: pressure,
    activeBiases,
    unhealthyAgents,
    now: services.clock(),
  });
  return out.detail === "single" ? out.route : null;
}
