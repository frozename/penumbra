import {
  type AgentRoutingConfig,
  type AgentTaskType,
  decide,
  type HarnessContext,
  inferAgentTaskTypeForRole,
  profileTaskDeterministic,
  readRoutingBiases,
  readSubscriptionPressure,
  type RoleRoute,
  routeAgent,
  type RouterAaSnapshot,
  type RoutingBias,
  type RoutingDecision,
  type Services,
} from "@penumbra/core";

/**
 * Shared read for user-driven routing biases ("usage steering"). Degrades to
 * undefined on any read error so a bias-store outage can never block a
 * dispatch. Both the primary route (resolveSingleRoute below) and the
 * chain-start fallback selectors in chains.ts call this, so all routing
 * decisions for one dispatch see the same steering data.
 */
export function readActiveRoutingBiases(services: Services): RoutingBias[] | undefined {
  try {
    return readRoutingBiases(services.db, { now: services.clock() });
  } catch {
    return undefined;
  }
}

type AgentRoutingWithRoleRouting = AgentRoutingConfig & {
  role_routing?: {
    headroom_weighting?: boolean;
    latency_weighting?: boolean;
    local_seat_health_gate?: boolean;
    exploration_policy?: string;
  };
};

/**
 * Thrown when the model task router (mode:'auto') excludes every candidate
 * via a hard constraint. Callers MUST surface this as a legible dispatch
 * failure rather than silently falling back to legacy routing -- doing so
 * would let a hard constraint (e.g. privacy local-only) be bypassed by the
 * back door the moment the pool it excludes reaches zero.
 */
export class RouterHardConstraintExhaustedError extends Error {
  readonly decision: RoutingDecision;

  constructor(decision: RoutingDecision) {
    super("model task router excluded every candidate via a hard constraint");
    this.name = "RouterHardConstraintExhaustedError";
    this.decision = decision;
  }
}

export class RoutingBiasExhaustedError extends Error {
  readonly role: string;
  readonly taskType: AgentTaskType;

  constructor(role: string, taskType: AgentTaskType) {
    super("routing biases excluded every role candidate");
    this.name = "RoutingBiasExhaustedError";
    this.role = role;
    this.taskType = taskType;
  }
}

export interface RouterDecisionSink {
  decision: RoutingDecision | null;
}

/**
 * Harness fields a caller may already have on hand (chains.ts, at the full
 * ChainStartRequest). handoffs.ts:302's bare chain-hop caller has none of
 * these and omits the parameter entirely -- resolveSingleRoute still
 * computes promptChars/role/availableAgents from its existing parameters.
 */
export interface RouterRoutingHints {
  taskClass?: string;
  projectId?: string;
  dispatchKind?: string;
  // No current caller sets this (no dispatch request field exists yet for
  // it); wired through so the already-landed privacy fail-closed hard
  // constraint (constraint-filter.ts) is reachable the moment one does,
  // instead of staying permanently dead behind the router integration.
  localOnly?: boolean;
  tool_free?: boolean;
  // Populated as a side effect when the router computes a decision. Needed
  // because chain_start mints handoff_id AFTER routing resolves (chains.ts
  // :1531 vs :1542), so the caller can't get a decisionId-bearing return
  // value out of resolveSingleRoute directly without changing its return
  // type (which would break handoffs.ts:302's byte-identical call site).
  decisionSink?: RouterDecisionSink;
}

function collectHarnessContext(opts: {
  services: Services;
  role: string;
  message: string;
  hints?: RouterRoutingHints;
}): HarnessContext {
  const { services, role, message, hints } = opts;
  return {
    role,
    promptChars: message.length,
    ...(hints?.taskClass !== undefined ? { taskClass: hints.taskClass } : {}),
    ...(hints?.projectId !== undefined ? { projectId: hints.projectId } : {}),
    ...(hints?.dispatchKind !== undefined ? { dispatchKind: hints.dispatchKind } : {}),
    ...(hints?.localOnly !== undefined ? { localOnly: hints.localOnly } : {}),
    ...(hints?.tool_free !== undefined ? { toolFree: hints.tool_free } : {}),
    ...(services.agentRegistry ? { availableAgents: services.agentRegistry } : {}),
  };
}

function readRouterAaSnapshot(services: Services): RouterAaSnapshot | undefined {
  const result = services.aaSnapshotStore.readSync();
  if (result.state !== "available") return undefined;
  return {
    snapshot: result.snapshot,
    stale: result.stale,
    ageSeconds: result.ageSeconds,
  };
}

function computeRouterDecision(opts: {
  services: Services;
  mode: "recommend" | "shadow" | "auto";
  role: string;
  message: string;
  taskType: AgentTaskType;
  hints?: RouterRoutingHints;
  agentchatConfig: {
    agents: AgentRoutingConfig["agents"];
    role_routing?: AgentRoutingWithRoleRouting["role_routing"];
  };
  pressure: ReturnType<typeof readSubscriptionPressure> | undefined;
  activeBiases: RoutingBias[] | undefined;
  unhealthyAgents: ReadonlySet<string> | undefined;
}): RoutingDecision | null {
  const { services, mode, role, message, taskType, hints } = opts;
  const routerConfig = services.taskRouterConfig;
  if (!routerConfig) return null;
  try {
    const harnessContext = collectHarnessContext({ services, role, message, hints });
    const taskProfile = profileTaskDeterministic(message, role, {
      taskType,
      taskClass: hints?.taskClass,
    });
    const aaSnapshot = readRouterAaSnapshot(services);
    return decide(
      {
        mode,
        db: services.db,
        role,
        message,
        taskType,
        taskProfile,
        harnessContext,
        routerConfig,
        aliasMap: services.modelAliasMap ?? {},
        aaSnapshot,
        agentchatConfig: opts.agentchatConfig,
        agentRegistry: services.agentRegistry ?? [],
        activeBiases: opts.activeBiases,
        applyPressure: opts.pressure,
        unhealthyAgents: opts.unhealthyAgents,
      },
      { now: () => services.clock() },
    );
  } catch (err) {
    // Degrade to legacy routing on any router failure (bad snapshot, config
    // bug) -- mirrors the pressure/bias read try/catch below. A throwing
    // router must never take down a dispatch.
    services.log.warn(
      {
        event: "model_task_router.decision_failed",
        role,
        mode,
        error: err instanceof Error ? err.message : String(err),
      },
      "model task router decision failed; degrading to legacy routing",
    );
    return null;
  }
}

function hasHardConstraintExclusion(decision: RoutingDecision): boolean {
  return decision.alternatives.some(
    (alternative) => alternative.excluded && alternative.reasons.length > 0,
  );
}

/**
 * Resolve a role to a concrete agent via routeAgent's 'single' detail mode.
 * Returns null when no agentchat routing config is present, when the role
 * has no eligible agents, or when routeAgent declines to bind. Callers
 * decide their own fallback policy for the null result.
 *
 * When routing hints are omitted, or services.taskRouterConfig.mode is 'off',
 * this is byte-identical to the pre-router implementation. With hints,
 * 'recommend'/'shadow' expose the decision via hints.decisionSink while
 * preserving the legacy route. In 'auto', a selected route is applied and an
 * evidenced hard-constraint wipeout throws RouterHardConstraintExhaustedError;
 * other no-selection decisions degrade to the legacy route.
 */
export function resolveSingleRoute(
  services: Services,
  role: string,
  message: string,
  taskType?: AgentTaskType,
  hints?: RouterRoutingHints,
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
  const activeBiases = readActiveRoutingBiases(services);
  let unhealthyAgents: ReadonlySet<string> | undefined;
  try {
    unhealthyAgents = services.localSeatHealth?.getUnhealthyAgents();
  } catch {
    // degrade gracefully
  }
  const agentchatConfig = {
    // agentRouting.agents already carries adapter via
    // loadAgentRoutingFromConfig, so the scorer can apply the tool-free
    // penalty for callers that set tool_free:true on RouteAgentInput.
    agents: agentRouting.agents,
    role_routing: agentRoutingWithRoleRouting.role_routing,
  };

  const mode = services.taskRouterConfig?.mode ?? "off";
  if (mode !== "off" && hints !== undefined) {
    const decision = computeRouterDecision({
      services,
      mode,
      role,
      message,
      taskType: resolvedTaskType,
      hints,
      agentchatConfig,
      pressure,
      activeBiases,
      unhealthyAgents,
    });
    if (decision) {
      if (hints.decisionSink) hints.decisionSink.decision = decision;
      if (mode === "auto") {
        if (decision.selected === null) {
          if (hasHardConstraintExclusion(decision)) {
            throw new RouterHardConstraintExhaustedError(decision);
          }
        } else {
          return { agent: decision.selected.agent, role, taskType: resolvedTaskType };
        }
      }
      // recommend/shadow: the decision is recorded above; routing itself
      // stays on the legacy path below so v1 never diverges live behavior
      // from a shadow evaluation.
    }
  }

  const out = routeAgent({
    db: services.db,
    detail: "single",
    role,
    message,
    taskType: resolvedTaskType,
    agentRegistry: services.agentRegistry,
    agentchatConfig,
    roleExplorationPolicy: agentRouting.role_exploration_policy,
    defaultRoles: agentRouting.default_roles,
    applyPressure: pressure,
    activeBiases,
    unhealthyAgents,
    tool_free: hints?.tool_free,
    now: services.clock(),
  });
  if (out.detail !== "single") return null;
  if (out.exhaustedReason === "bias_excluded") {
    throw new RoutingBiasExhaustedError(role, resolvedTaskType);
  }
  return out.route;
}
