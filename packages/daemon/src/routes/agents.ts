import { WORKLOADS } from "@penumbra/config";
import {
  AgentPerformanceCaptureFromDispatchSchema,
  AgentPerformanceCaptureFromReconcilerSchema,
  AgentPerformanceMarkdownParseInputSchema,
  AgentPerformanceRowSchema,
  AgentPerformanceWriter,
  AgentRankInputSchema,
  AgentRecommendInputSchema,
  type AgentTaskType,
  captureAgentPerformanceFromDispatch,
  captureAgentPerformanceFromReconciler,
  ImportMarkdownResultSchema,
  inferAgentTaskTypeForRole,
  parseAgentPerformanceMarkdownRows,
  type PressureWarning,
  readFleetLatency,
  readSubscriptionPressure,
  recordOperatorAgentPerformance,
  RecordOperatorAgentPerformanceInputSchema,
  renderAgentPerformanceMarkdown,
  routeAgent,
  type Services,
} from "@penumbra/core";
import { z } from "zod";

import { getPrincipal } from "../auth.js";
import { json } from "./_helpers.js";
type Workload = (typeof WORKLOADS)[number];
type AgentRecommendDeprecationLogger = { info: (message: string) => void };
const taskTypeDeprecationLogged = new Set<AgentRecommendDeprecationLogger>();

export type AgentRoutePressureSnapshot = {
  snapshots: {
    provider: string;
    window_label: string;
    model: string | null;
    used_pct: number;
    resets_at: number | null;
    observed_at: string;
    source_kind: string;
  }[];
  warnings?: PressureWarning[];
};

export type AgentRouteAgentchatConfig = {
  agents: {
    name: string;
    roles: string[];
    subscription_provider?: string;
    api_provider?: string;
    pricing_mode?: "api" | "subscription";
  }[];
};

export type AgentRouteForInput = {
  db: Services["db"];
  role: string;
  windowDays?: number;
  minSamples?: number;
  agentKind?: "coding" | "long_lived";
  pressureSnapshot?: AgentRoutePressureSnapshot;
  agentchatRoles: AgentRouteAgentchatConfig;
  roleExplorationPolicy?: "unsampled-first" | "ranked-first";
  defaultRoles?: Record<string, string>;
};

export type AgentRouteChosen = {
  agent: string;
  success_rate: number;
  samples: number;
  roles: string[];
};

export type AgentRouteRejectedReason =
  | "no_role_match"
  | "under_pressure"
  | "below_min_samples"
  | "lower_success_rate";

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

const AgentRouteForQuerySchema = z.object({
  role: z.string().min(1),
  window_days: z.coerce.number().int().positive().max(365).optional(),
  min_samples: z.coerce.number().int().positive().max(1000).optional(),
  agent_kind: z.enum(["coding", "long_lived"]).optional(),
});

const FleetLatencyQuerySchema = z.object({
  window_hours: z.coerce
    .number()
    .positive()
    .max(24 * 30)
    .default(24),
});

function readOptionalWorkloadQueryValue(value: string | null): {
  value: Workload | undefined;
  error?: string;
} {
  if (value === null || value.length === 0) return { value: undefined };
  if ((WORKLOADS as readonly string[]).includes(value)) return { value: value as Workload };
  return { value: undefined, error: `Invalid input: expected one of ${WORKLOADS.join(", ")}` };
}

function resolveWorkloadCandidateRegistry(
  services: Services,
  workload: Workload | undefined,
): string[] | null {
  if (workload === undefined) return null;
  const cfg = services.agentchatConfig as
    | {
        agents?: { name: string; roles?: string[] }[];
        workloads?: Partial<
          Record<Workload, { eligible_roles?: string[]; eligible_agents?: string[] }>
        >;
      }
    | undefined;
  const workloads = cfg?.workloads;
  const workloadCfg = workloads ? workloads[workload] : undefined;
  if (!workloadCfg) return null;

  const candidates = new Set<string>(workloadCfg.eligible_agents ?? []);
  const eligibleRoles = new Set(workloadCfg.eligible_roles ?? []);
  if (eligibleRoles.size > 0) {
    for (const agent of cfg?.agents ?? []) {
      const roles = Array.isArray(agent.roles) ? agent.roles : [];
      if (roles.some((role) => eligibleRoles.has(role))) {
        candidates.add(agent.name);
      }
    }
  }
  return [...candidates];
}

function resolveProvider(agent: AgentRouteAgentchatConfig["agents"][number]): string | null {
  if (agent.pricing_mode === "subscription") return agent.subscription_provider ?? null;
  return agent.api_provider ?? agent.subscription_provider ?? null;
}

function isOverPressure(provider: string, pressureSnapshot?: AgentRoutePressureSnapshot): boolean {
  if (!pressureSnapshot) return false;
  return pressureSnapshot.snapshots.some(
    (snapshot) =>
      snapshot.provider === provider &&
      (snapshot.used_pct >= 90 || snapshot.source_kind === "cooldown"),
  );
}

type AgentchatAgent = AgentRouteAgentchatConfig["agents"][number];
type Recommendation = AgentRouteForReturn["recommendation"];
type AgentRouteForReturn = {
  recommendation: {
    agent_name: string;
    success_rate: number;
    samples: number;
  };
};

function classifyAgentRejection(
  agent: AgentchatAgent,
  input: AgentRouteForInput,
  recommendations: Recommendation[],
  minSamples: number,
): AgentRouteRejected | null {
  if (!agent.roles.includes(input.role)) {
    return { agent: agent.name, reason: "no_role_match" };
  }
  const provider = resolveProvider(agent);
  if (provider && isOverPressure(provider, input.pressureSnapshot)) {
    return { agent: agent.name, reason: "under_pressure", details: provider };
  }
  const recommendation = recommendations.find((rec) => rec.agent_name === agent.name);
  if (!recommendation || recommendation.samples < minSamples) {
    return {
      agent: agent.name,
      reason: "below_min_samples",
      details: String(recommendation?.samples ?? 0),
    };
  }
  return null;
}

function tryExploration(
  input: AgentRouteForInput,
  taskType: ReturnType<typeof inferAgentTaskTypeForRole>,
  byAgent: Map<string, AgentchatAgent>,
  recommendations: Recommendation[],
  rejected: AgentRouteRejected[],
): AgentRouteForOutput | null {
  const single = routeAgent({
    db: input.db,
    detail: "single",
    role: input.role,
    taskType,
    windowDays: input.windowDays,
    agentKind: input.agentKind,
    agentchatConfig: input.agentchatRoles,
    roleExplorationPolicy: "unsampled-first",
    defaultRoles: input.defaultRoles,
    applyPressure: input.pressureSnapshot,
  });
  if (single.detail !== "single") {
    throw new Error("unexpected routeAgent detail for computeRouteForRole exploration");
  }
  if (!single.route) return null;
  const route = single.route;
  const rec = recommendations.find((candidate) => candidate.agent_name === route.agent);
  const agent = byAgent.get(route.agent);
  return {
    chosen: {
      agent: route.agent,
      success_rate: rec?.success_rate ?? 0,
      samples: rec?.samples ?? 0,
      roles: agent?.roles ?? [],
    },
    rejected,
    reason: `chose ${route.agent} via unsampled-first exploration`,
  };
}

export function computeRouteForRole(input: AgentRouteForInput): AgentRouteForOutput {
  const minSamples = input.minSamples ?? 3;
  const taskType = inferAgentTaskTypeForRole("", input.role);
  const routeSummary = routeAgent({
    db: input.db,
    detail: "summary",
    taskType,
    windowDays: input.windowDays,
    agentKind: input.agentKind,
  });
  if (routeSummary.detail !== "summary") {
    throw new Error("unexpected routeAgent detail for computeRouteForRole");
  }
  const recommendations = routeSummary.recommendations;

  const byAgent = new Map(input.agentchatRoles.agents.map((agent) => [agent.name, agent] as const));
  const roleMatches = input.agentchatRoles.agents.filter((agent) =>
    agent.roles.includes(input.role),
  );
  const rankedRoleMatches = recommendations.filter((rec) => {
    const matched = byAgent.get(rec.agent_name);
    return matched?.roles.includes(input.role) ?? false;
  });
  const rejected: AgentRouteRejected[] = input.agentchatRoles.agents
    .map((agent) => classifyAgentRejection(agent, input, recommendations, minSamples))
    .filter((row): row is AgentRouteRejected => row !== null);

  const eligible = rankedRoleMatches.filter((rec) => {
    const agent = byAgent.get(rec.agent_name);
    if (!agent) return false;
    const provider = resolveProvider(agent);
    if (provider && isOverPressure(provider, input.pressureSnapshot)) return false;
    return rec.samples >= minSamples;
  });

  const chosenRec = eligible[0] ?? null;
  if (!chosenRec) {
    const roleExplorationPolicy = input.roleExplorationPolicy ?? "unsampled-first";
    if (roleExplorationPolicy === "unsampled-first") {
      const explored = tryExploration(input, taskType, byAgent, recommendations, rejected);
      if (explored) return explored;
    }
    const filteredOut = roleMatches.length - eligible.length;
    return {
      chosen: null,
      rejected,
      reason: `no eligible agent — ${String(filteredOut)} filtered out by role, ${String(rejected.filter((r) => r.reason === "under_pressure").length)} by pressure, ${String(rejected.filter((r) => r.reason === "below_min_samples").length)} by min_samples`,
    };
  }

  const chosen: AgentRouteChosen = {
    agent: chosenRec.agent_name,
    success_rate: chosenRec.success_rate,
    samples: chosenRec.samples,
    roles: byAgent.get(chosenRec.agent_name)?.roles ?? [],
  };

  for (const rec of eligible.slice(1)) {
    rejected.push({
      agent: rec.agent_name,
      reason: "lower_success_rate",
      details: String(rec.success_rate),
    });
  }

  return {
    chosen,
    rejected,
    reason: `chose ${chosen.agent} (success_rate ${String(chosen.success_rate)}, ${String(chosen.samples)} samples) over ${String(Math.max(0, eligible.length - 1))} other role-matching agents`,
  };
}

function workerMismatchResponse(): Response {
  return json(
    {
      error: {
        code: "handoff_worker_mismatch",
        message: "worker token does not own this handoff",
      },
    },
    403,
  );
}

function applyDispatchCaptureTrustBoundary(opts: {
  principal: ReturnType<typeof getPrincipal>;
  handoffWorkerId: string | null;
  input: {
    final_response_chars?: number;
    has_meaningful_output?: boolean;
    task_type?: AgentTaskType;
    worktree_changed?: boolean | null;
    dispatch_end_emitted?: boolean;
  };
}): Response | null {
  const { principal, handoffWorkerId, input } = opts;
  if (principal?.kind === "worker") {
    // A null owner is legitimate (orphan recovery, pre-claim capture) —
    // only an actual DIFFERENT owner is a mismatch.
    if (handoffWorkerId !== null && handoffWorkerId !== principal.worker_id) {
      return workerMismatchResponse();
    }
    if (handoffWorkerId === null) {
      delete input.dispatch_end_emitted;
    }
    return null;
  }

  // Non-worker principals (shared bearer: CLI-loop captures, tooling)
  // cannot prove handoff ownership. Strip the trust-sensitive hints so
  // capture falls back to server-derived values (scoped t0 read,
  // chain_task_type, computed worktree signals) instead of rejecting the
  // capture outright.
  delete input.final_response_chars;
  delete input.has_meaningful_output;
  delete input.task_type;
  delete input.worktree_changed;
  delete input.dispatch_end_emitted;
  return null;
}

export async function agentsPerformanceReconcilerRoute(
  req: Request,
  services: Services,
): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = AgentPerformanceCaptureFromReconcilerSchema.safeParse(raw);
  if (!parsed.success)
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  try {
    const performance = captureAgentPerformanceFromReconciler({
      db: services.db,
      uuid: services.uuid,
      clock: services.clock,
      input: parsed.data,
    });
    return json({ performance });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("handoff not found:")) {
      return json({ error: { code: "not_found", message: err.message } }, 404);
    }
    throw err;
  }
}

export async function agentsPerformanceDispatchRoute(
  req: Request,
  services: Services,
): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = AgentPerformanceCaptureFromDispatchSchema.safeParse(raw);
  if (!parsed.success)
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  try {
    const input = { ...parsed.data };
    const principal = getPrincipal(req);
    const handoffOwner = services.db
      .query<
        { worker_id: string | null },
        [string]
      >(`SELECT worker_id FROM handoffs WHERE handoff_id = ?`)
      .get(input.handoff_id);
    if (!handoffOwner) return json({ error: { code: "not_found" } }, 404);
    const trustBoundaryResponse = applyDispatchCaptureTrustBoundary({
      principal,
      handoffWorkerId: handoffOwner.worker_id,
      input,
    });
    if (trustBoundaryResponse) return trustBoundaryResponse;
    const performance = captureAgentPerformanceFromDispatch({
      db: services.db,
      uuid: services.uuid,
      clock: services.clock,
      input,
    });
    return json({ performance });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("handoff not found:")) {
      return json({ error: { code: "not_found", message: err.message } }, 404);
    }
    throw err;
  }
}

export async function agentsPerformanceOperatorRoute(
  req: Request,
  services: Services,
): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = RecordOperatorAgentPerformanceInputSchema.safeParse(raw);
  if (!parsed.success)
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  try {
    const performance = recordOperatorAgentPerformance({
      db: services.db,
      uuid: services.uuid,
      clock: services.clock,
      input: parsed.data,
    });
    return json({ performance });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("handoff not found:")) {
      return json({ error: { code: "not_found", message: err.message } }, 404);
    }
    return internalError(err);
  }
}

export async function agentsPerformanceImportMarkdownRoute(
  req: Request,
  services: Services,
): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = AgentPerformanceMarkdownParseInputSchema.safeParse(raw);
  if (!parsed.success)
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  try {
    const rows = parseAgentPerformanceMarkdownRows(parsed.data);
    const writer = new AgentPerformanceWriter(services.db);
    for (const row of rows) writer.upsert(row);
    // AgentPerformanceWriter is a replace-on-conflict upsert keyed by handoff_id, so imports are counted as imported.
    const result = ImportMarkdownResultSchema.parse({ imported: rows.length, skipped: 0 });
    return json(result);
  } catch (err) {
    if (isImportValidationError(err)) {
      return json({ error: { code: "invalid_params", message: err.message } }, 400);
    }
    return internalError(err);
  }
}

export function agentsPerformanceMarkdownRoute(_req: Request, services: Services): Response {
  try {
    const rows = services.db
      .query<
        ReturnType<typeof AgentPerformanceRowSchema.parse>,
        []
      >("SELECT * FROM agent_performance ORDER BY ts ASC")
      .all();
    const markdown = renderAgentPerformanceMarkdown(rows, { generatedAt: services.clock() });
    return new Response(markdown, {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  } catch (err) {
    return internalError(err);
  }
}

export function agentsRankRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const parsed = AgentRankInputSchema.safeParse({
    task_type: url.searchParams.get("task_type") ?? undefined,
    since: url.searchParams.get("since") ?? undefined,
    min_samples: url.searchParams.get("min_samples") ?? undefined,
    agent_kind: url.searchParams.get("agent_kind") ?? undefined,
    include_neutral: url.searchParams.get("include_neutral") ?? undefined,
    include_cost: url.searchParams.get("include_cost") ?? undefined,
  });
  if (!parsed.success)
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  const agentchatConfig =
    services.agentchatConfig !== undefined
      ? { agents: services.agentchatConfig.agents ?? [] }
      : undefined;
  const out = routeAgent({
    db: services.db,
    detail: "rank",
    taskType: parsed.data.task_type,
    since: parsed.data.since,
    minSamples: parsed.data.min_samples,
    agentKind: parsed.data.agent_kind,
    includeNeutral: parsed.data.include_neutral,
    includeCost: parsed.data.include_cost,
    agentchatConfig,
    now: services.clock(),
  });
  if (out.detail !== "rank") throw new Error("unexpected routeAgent detail for agentsRankRoute");
  return json(out.candidates);
}

export function agentsFleetLatencyRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const parsed = FleetLatencyQuerySchema.safeParse({
    window_hours: url.searchParams.get("window_hours") ?? undefined,
  });
  if (!parsed.success)
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  return json(
    readFleetLatency(services.db, {
      window_hours: parsed.data.window_hours,
      now: services.clock(),
    }),
  );
}

function logTaskTypeDeprecation(services: Services): void {
  const logger = (typeof (services.log as { info?: unknown } | undefined)?.info === "function"
    ? services.log
    : console) as unknown as AgentRecommendDeprecationLogger;
  if (!taskTypeDeprecationLogged.has(logger)) {
    logger.info("agent_recommend: task_type is deprecated; prefer 'workload' instead");
    taskTypeDeprecationLogged.add(logger);
  }
}

function validateRecommendInputs(
  workloadField: { value: Workload | undefined; error?: string },
  taskType: string | undefined,
): Response | null {
  if (workloadField.error) {
    return json(
      {
        error: {
          code: "invalid_params",
          issues: [{ path: ["workload"], message: workloadField.error }],
        },
      },
      400,
    );
  }
  if (
    workloadField.value !== undefined &&
    taskType !== undefined &&
    workloadField.value !== taskType
  ) {
    return json(
      {
        error: {
          code: "validation_error",
          message: `agent_recommend: workload='${workloadField.value}' conflicts with task_type='${taskType}'; pass only one or matching values`,
        },
      },
      400,
    );
  }
  return null;
}

export function agentsRecommendRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const workloadField = readOptionalWorkloadQueryValue(url.searchParams.get("workload"));
  const taskType = url.searchParams.get("task_type") ?? undefined;
  const validation = validateRecommendInputs(workloadField, taskType);
  if (validation) return validation;
  if (workloadField.value === undefined && taskType !== undefined) {
    logTaskTypeDeprecation(services);
  }
  const resolvedTaskType = workloadField.value ?? taskType;
  const parsed = AgentRecommendInputSchema.safeParse({
    task_type: resolvedTaskType,
    risk_class: url.searchParams.get("risk_class") ?? undefined,
    window_days: url.searchParams.get("window_days") ?? undefined,
    agent_kind: url.searchParams.get("agent_kind") ?? undefined,
  });
  if (!parsed.success)
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  const workloadForRouting =
    resolvedTaskType !== undefined && (WORKLOADS as readonly string[]).includes(resolvedTaskType)
      ? (resolvedTaskType as Workload)
      : undefined;
  const out = routeAgent({
    db: services.db,
    detail: "summary",
    taskType: parsed.data.task_type as AgentTaskType,
    riskClass: parsed.data.risk_class,
    windowDays: parsed.data.window_days,
    agentKind: parsed.data.agent_kind,
    agentRegistry: resolveWorkloadCandidateRegistry(services, workloadForRouting),
    now: services.clock(),
  });
  if (out.detail !== "summary")
    throw new Error("unexpected routeAgent detail for agentsRecommendRoute");
  return json(out.recommendations);
}

export function agentsRouteForRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const parsed = AgentRouteForQuerySchema.safeParse({
    role: url.searchParams.get("role") ?? undefined,
    window_days: url.searchParams.get("window_days") ?? undefined,
    min_samples: url.searchParams.get("min_samples") ?? undefined,
    agent_kind: url.searchParams.get("agent_kind") ?? undefined,
  });
  if (!parsed.success)
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  const agentchatConfig = services.agentchatConfig;
  if (!agentchatConfig)
    return json(
      { error: { code: "invalid_params", message: "agentchat config unavailable" } },
      400,
    );
  return json(
    computeRouteForRole({
      db: services.db,
      role: parsed.data.role,
      windowDays: parsed.data.window_days,
      minSamples: parsed.data.min_samples,
      agentKind: parsed.data.agent_kind,
      pressureSnapshot: readSubscriptionPressure(services.db),
      agentchatRoles: { agents: agentchatConfig.agents ?? [] },
      roleExplorationPolicy: services.agentRouting?.role_exploration_policy,
      defaultRoles: services.agentRouting?.default_roles,
    }),
  );
}

function internalError(err: unknown): Response {
  return json(
    {
      error: {
        code: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      },
    },
    500,
  );
}

function isImportValidationError(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err.message.startsWith("invalid agent performance markdown input:") ||
      err.message.startsWith("invalid agent performance markdown row at line "))
  );
}
