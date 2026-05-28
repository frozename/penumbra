import { z } from "zod";
import type { Services } from "@penumbra/core";
import {
  AgentPerformanceMarkdownParseInputSchema,
  AgentPerformanceRowSchema,
  AgentPerformanceCaptureFromDispatchSchema,
  AgentPerformanceCaptureFromReconcilerSchema,
  AgentRankInputSchema,
  AgentPerformanceWriter,
  ImportMarkdownResultSchema,
  RecordOperatorAgentPerformanceInputSchema,
  captureAgentPerformanceFromDispatch,
  captureAgentPerformanceFromReconciler,
  parseAgentPerformanceMarkdownRows,
  recordOperatorAgentPerformance,
  renderAgentPerformanceMarkdown,
  routeAgent,
} from "@penumbra/core";
import { readSubscriptionPressure } from "@penumbra/core";
import { AgentRecommendInputSchema } from "@penumbra/core";
import { WORKLOADS } from "@penumbra/config";

import { json } from "./_helpers.js";
type Workload = (typeof WORKLOADS)[number];
type AgentRecommendDeprecationLogger = { info: (message: string) => void };
const taskTypeDeprecationLogged = new Set<AgentRecommendDeprecationLogger>();

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
    pricing_mode?: "api" | "subscription";
  }>;
};

export type AgentRouteForInput = {
  db: Services["db"];
  role: string;
  windowDays?: number;
  minSamples?: number;
  agentKind?: "coding" | "long_lived";
  pressureSnapshot?: AgentRoutePressureSnapshot;
  agentchatRoles: AgentRouteAgentchatConfig;
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

function readOptionalWorkloadQueryValue(value: string | null): {
  value: Workload | undefined;
  error?: string;
} {
  if (value == null || value.length === 0) return { value: undefined };
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
        agents?: Array<{ name: string; roles?: string[] }>;
        workloads?: Partial<
          Record<Workload, { eligible_roles?: string[]; eligible_agents?: string[] }>
        >;
      }
    | undefined;
  const workloadCfg = cfg?.workloads?.[workload];
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
      (snapshot.used_pct >= 0.9 || snapshot.source_kind === "cooldown"),
  );
}

export function computeRouteForRole(input: AgentRouteForInput): AgentRouteForOutput {
  const minSamples = input.minSamples ?? 3;
  const routeSummary = routeAgent({
    db: input.db,
    detail: "summary",
    taskType: input.role as any,
    windowDays: input.windowDays,
    agentKind: input.agentKind,
  });
  if (routeSummary.detail !== "summary") {
    throw new Error("unexpected routeAgent detail for computeRouteForRole");
  }
  const recommendations = routeSummary.recommendations;

  const byAgent = new Map(input.agentchatRoles.agents.map((agent) => [agent.name, agent] as const));
  const rejected: AgentRouteRejected[] = [];
  const roleMatches = input.agentchatRoles.agents.filter((agent) =>
    agent.roles.includes(input.role),
  );
  const rankedRoleMatches = recommendations.filter(
    (rec) => byAgent.has(rec.agent_name) && byAgent.get(rec.agent_name)!.roles.includes(input.role),
  );

  for (const agent of input.agentchatRoles.agents) {
    if (!agent.roles.includes(input.role)) {
      rejected.push({ agent: agent.name, reason: "no_role_match" });
      continue;
    }

    const provider = resolveProvider(agent);
    if (provider && isOverPressure(provider, input.pressureSnapshot)) {
      rejected.push({ agent: agent.name, reason: "under_pressure", details: provider });
      continue;
    }

    const recommendation = recommendations.find((rec) => rec.agent_name === agent.name);
    if (!recommendation || recommendation.samples < minSamples) {
      rejected.push({
        agent: agent.name,
        reason: "below_min_samples",
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
  const chosen = chosenRec
    ? {
        agent: chosenRec.agent_name,
        success_rate: chosenRec.success_rate,
        samples: chosenRec.samples,
        roles: byAgent.get(chosenRec.agent_name)?.roles ?? [],
      }
    : null;

  if (!chosen) {
    const filteredOut = roleMatches.length - eligible.length;
    return {
      chosen: null,
      rejected,
      reason: `no eligible agent — ${filteredOut} filtered out by role, ${rejected.filter((r) => r.reason === "under_pressure").length} by pressure, ${rejected.filter((r) => r.reason === "below_min_samples").length} by min_samples`,
    };
  }

  for (const rec of eligible.slice(1)) {
    rejected.push({
      agent: rec.agent_name,
      reason: "lower_success_rate",
      details: `${rec.success_rate}`,
    });
  }

  return {
    chosen,
    rejected,
    reason: `chose ${chosen.agent} (success_rate ${chosen.success_rate}, ${chosen.samples} samples) over ${Math.max(0, eligible.length - 1)} other role-matching agents`,
  };
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
    const performance = captureAgentPerformanceFromDispatch({
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

export async function agentsPerformanceMarkdownRoute(
  _req: Request,
  services: Services,
): Promise<Response> {
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

export async function agentsRankRoute(req: Request, services: Services): Promise<Response> {
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
  const out = routeAgent({
    db: services.db,
    detail: "rank",
    taskType: parsed.data.task_type,
    since: parsed.data.since,
    minSamples: parsed.data.min_samples,
    agentKind: parsed.data.agent_kind,
    includeNeutral: parsed.data.include_neutral,
    includeCost: parsed.data.include_cost,
    now: services.clock(),
  });
  if (out.detail !== "rank") throw new Error("unexpected routeAgent detail for agentsRankRoute");
  return json(out.candidates);
}

export async function agentsRecommendRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const workloadField = readOptionalWorkloadQueryValue(url.searchParams.get("workload"));
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
  const taskType = url.searchParams.get("task_type") ?? undefined;
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
  if (workloadField.value === undefined && taskType !== undefined) {
    const logger = (services.log && typeof (services.log as { info?: unknown }).info === "function"
      ? services.log
      : console) as unknown as AgentRecommendDeprecationLogger;
    if (!taskTypeDeprecationLogged.has(logger)) {
      logger.info("agent_recommend: task_type is deprecated; prefer 'workload' instead");
      taskTypeDeprecationLogged.add(logger);
    }
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
    taskType: parsed.data.task_type as any,
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

export async function agentsRouteForRoute(req: Request, services: Services): Promise<Response> {
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
