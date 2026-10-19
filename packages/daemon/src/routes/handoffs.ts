import { HandoffFailRequestSchema } from "@penumbra/api-contract";
import {
  agentEnforcesPermissionProfile,
  ApproveHandoffRequestSchema,
  buildDispatchAuditReportForHandoff,
  CreateHandoffRequestSchema,
  type HandoffStatus,
  HandoffStatusSchema,
  type PermissionProfile,
  type Services,
} from "@penumbra/core";
import { z } from "zod";

import type { DaemonServices } from "../serve.js";
import type { ExtraWorkerConfig } from "../workers/config.js";

import { getPrincipal, requireWorkerPrincipalMatch } from "../auth.js";
import { handleTickTeardown, type TickOutcome } from "../long-lived/teardown.js";
import {
  countProviderInFlight,
  type ProviderConcurrencyDecision,
  recordProviderCapRefusal,
  resolveProviderConcurrencyDecision,
} from "../services/provider-concurrency.js";
import { json } from "./_helpers.js";
import { enforceRecursionDepthGuard, getNearestAgents } from "./chains.js";
import {
  resolveSingleRoute,
  RouterHardConstraintExhaustedError,
  RoutingBiasExhaustedError,
} from "./role-routing.js";
import {
  profiledLiveWorkerGateResponse,
  workerCanClaimProject,
  workerHeartbeatStaleMs,
  workerTokenMetadataDeclaresProfile,
  workerTokenMetadataDeclaresScratch,
} from "./worker-profile-gate.js";
// bun:sqlite returns 0/1 for BOOLEAN columns; coerce here so the JSON API
// contract is boolean|null regardless of whether the reader layer already
// normalised the value (belt-and-suspenders for legacy data paths).
function coerceHandoffBooleans<T extends { use_worktree: unknown; open_pr_on_review?: unknown }>(
  row: T,
): T {
  const b = (v: unknown): boolean | null =>
    v === 1 ? true : v === 0 ? false : v === null || v === undefined ? null : (v as boolean);
  return {
    ...row,
    use_worktree: b(row.use_worktree),
    open_pr_on_review: b(row.open_pr_on_review) ?? undefined,
  };
}

const NULL_PROJECT_ID_SENTINEL = "__null__"; // Sentinel token that maps to SQL NULL.
const VALID_STATUSES = new Set<string>(HandoffStatusSchema.options);

interface LongLivedTickRow {
  id: string;
  agent_id: string;
  chain_id: string | null;
  completed_at: number | null;
  outcome: string | null;
}

interface AgentPerformanceCostRow {
  cost_usd: number | null;
}

interface ClaimSpreadDecision {
  workflow_run_id: string;
  active_worker_count: number;
  sibling_count: number;
  max_per_worker: number;
}

interface WorkerTokenWorkerRow {
  worker_id: string;
}

interface CountRow {
  n: number;
}

interface WorkerTokenMetadataRow {
  metadata_json: string | null;
}

// Capability gates key on the PRESENTING bearer token's registration row,
// not the newest row for the worker_id: a rotated registration must not
// silently grant (or strip) capabilities claimed by the token in hand.
function presentingTokenMetadata(services: Services, token_hash: string): string | null {
  const row = services.db
    .query<WorkerTokenMetadataRow, [string]>(
      `SELECT metadata_json
         FROM worker_tokens
        WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .get(token_hash);
  return row?.metadata_json ?? null;
}

function workerDeclaresProfileEnforcement(
  services: Services,
  token_hash: string,
  profile: PermissionProfile,
): boolean {
  return workerTokenMetadataDeclaresProfile(presentingTokenMetadata(services, token_hash), profile);
}

// Claim gate keyed on the presenting worker's registration metadata: a
// scratch-routed handoff must stay unclaimable for workers that never
// declared scratch support.
function workerDeclaresScratchSupport(services: Services, token_hash: string): boolean {
  return workerTokenMetadataDeclaresScratch(presentingTokenMetadata(services, token_hash));
}

// A chain hop inherits the parent's permission profile unless the hop names
// one explicitly; a hop can never drop its parent's profile because null is
// treated as "not specified".
function resolveEffectivePermissionProfile(
  input: { permission_profile?: PermissionProfile | null; parent_handoff_id?: string | null },
  services: Services,
): PermissionProfile | null {
  const parentProfile = input.parent_handoff_id
    ? (services.handoffReader.get(input.parent_handoff_id)?.permission_profile ?? null)
    : null;
  return input.permission_profile ?? parentProfile;
}

// caller_cwd follows the same inheritance as permission_profile: hops inherit
// the chain root's caller cwd so the worker's Layer B deny set keeps covering
// the originating repository across every hop.
function resolveEffectiveCallerCwd(
  input: { caller_cwd?: string | null; parent_handoff_id?: string | null },
  services: Services,
): string | null {
  const parentCwd = input.parent_handoff_id
    ? (services.handoffReader.get(input.parent_handoff_id)?.caller_cwd ?? null)
    : null;
  return input.caller_cwd ?? parentCwd;
}

// cwd_override never crosses a hop boundary on the create route: scratch
// roots are bound to the run that acquired them, scratch dispatches pin
// max_hops:1, and a direct cwd_override is only legal on the in-process
// chain_start path.
function scratchBoundaryGateResponse(
  data: {
    cwd_override?: string | null;
    parent_handoff_id?: string | null;
    project_id?: string | null;
  },
  services: Services,
): Response | null {
  const parentCwdOverride = data.parent_handoff_id
    ? (services.handoffReader.get(data.parent_handoff_id)?.cwd_override ?? null)
    : null;
  if (parentCwdOverride !== null) {
    return json(
      {
        error: {
          code: "cwd_override_parent_scratch",
          message:
            "child handoffs are not allowed under a scratch-bound parent; scratch dispatches pin max_hops:1",
          parent_cwd_override: parentCwdOverride,
        },
      },
      400,
    );
  }
  if (data.cwd_override !== undefined && data.cwd_override !== null) {
    return json(
      {
        error: {
          code: "cwd_override_not_allowed",
          message: "cwd_override is only accepted on the in-process workflow dispatch path",
        },
      },
      400,
    );
  }
  return null;
}

function profiledSeatGateResponse(
  services: Services,
  agent: string,
  profile: PermissionProfile,
): Response | null {
  const seat = services.agentchatConfig?.agents?.find((candidate) => candidate.name === agent);
  if (agentEnforcesPermissionProfile(seat, profile)) return null;
  services.log.warn(
    {
      event: "handoffs_create.permission_profile_unenforceable",
      agent,
      permission_profile: profile,
    },
    "handoff-create profiled hop rejected: seat cannot enforce the profile",
  );
  return json(
    {
      error: {
        code: "permission_profile_unenforceable",
        message: `agent '${agent}' cannot enforce permission_profile '${profile}'`,
        agent,
        permission_profile: profile,
      },
    },
    422,
  );
}

function profiledDispatchGateResponse(
  services: Services,
  routedAgent: string,
  effectiveProfile: PermissionProfile | null,
  projectId: string | null,
): Response | null {
  if (effectiveProfile === null) return null;
  return (
    profiledSeatGateResponse(services, routedAgent, effectiveProfile) ??
    profiledLiveWorkerGateResponse(services, effectiveProfile, projectId)
  );
}

function countFreshEligibleWorkers(services: DaemonServices, project_id: string | null): number {
  const cutoff = Date.now() - workerHeartbeatStaleMs();
  const rows = services.db
    .query<WorkerTokenWorkerRow, [number]>(
      `SELECT DISTINCT worker_id
         FROM worker_tokens
        WHERE revoked_at IS NULL
          AND last_seen_at >= ?`,
    )
    .all(cutoff);
  let n = 0;
  for (const row of rows) {
    if (workerCanClaimProject(services.workerAuthz?.get(row.worker_id), project_id)) n++;
  }
  return n;
}

function agentUsesWarmPool(services: DaemonServices, agentName: string): boolean {
  const agents = services.agentchatConfig?.agents;
  if (!Array.isArray(agents)) return false;
  const agent = agents.find((candidate) => candidate.name === agentName);
  return agent?.options?.warm_pool === true;
}

function workerHasWarmClaimAdvantage(
  services: DaemonServices,
  handoff: { project_id: string | null; to_agent: string },
  worker_id: string,
): boolean {
  if (!agentUsesWarmPool(services, handoff.to_agent)) return false;
  const authz = services.workerAuthz?.get(worker_id);
  if (handoff.project_id === null) return authz?.project_id === undefined;
  return authz?.project_id === handoff.project_id;
}

function countWorkflowGroupSiblings(services: DaemonServices, workflow_run_id: string): number {
  const row = services.db
    .query<CountRow, [string]>(
      `SELECT COUNT(*) AS n
         FROM handoffs
        WHERE dispatch_kind='workflow'
          AND workflow_run_id=?
          AND status IN ('approved','redirected','dispatched')`,
    )
    .get(workflow_run_id);
  return row?.n ?? 0;
}

function countWorkflowGroupClaimsForWorker(
  services: DaemonServices,
  workflow_run_id: string,
  worker_id: string,
): number {
  const row = services.db
    .query<CountRow, [string, string]>(
      `SELECT COUNT(*) AS n
         FROM handoffs
        WHERE dispatch_kind='workflow'
          AND workflow_run_id=?
          AND status='dispatched'
          AND worker_id=?`,
    )
    .get(workflow_run_id, worker_id);
  return row?.n ?? 0;
}

function resolveClaimSpreadDecision(
  services: DaemonServices,
  handoff: {
    dispatch_kind?: string | null;
    workflow_run_id?: string | null;
    project_id: string | null;
    to_agent: string;
  },
  worker_id: string,
): ClaimSpreadDecision | null {
  if (handoff.dispatch_kind !== "workflow" || !handoff.workflow_run_id) return null;
  if (workerHasWarmClaimAdvantage(services, handoff, worker_id)) return null;

  const active_worker_count = countFreshEligibleWorkers(services, handoff.project_id);
  if (active_worker_count <= 1) return null;

  const sibling_count = countWorkflowGroupSiblings(services, handoff.workflow_run_id);
  if (sibling_count <= 1) return null;

  return {
    workflow_run_id: handoff.workflow_run_id,
    active_worker_count,
    sibling_count,
    max_per_worker: Math.ceil(sibling_count / active_worker_count) + 1,
  };
}

function claimSpreadCapResponse(handoff_id: string, decision: ClaimSpreadDecision): Response {
  return json(
    {
      error: {
        code: "claim_spread_cap",
        message: `handoff ${handoff_id} belongs to workflow fan-out ${decision.workflow_run_id}; worker is at the sibling claim cap`,
      },
      workflow_run_id: decision.workflow_run_id,
      sibling_count: decision.sibling_count,
      active_worker_count: decision.active_worker_count,
      max_per_worker: decision.max_per_worker,
    },
    409,
  );
}

function providerConcurrencyCapResponse(
  services: DaemonServices,
  handoff_id: string,
  worker_id: string,
  decision: ProviderConcurrencyDecision,
  path: "precheck" | "cas_loss",
): Response {
  // This status MUST remain retryable per agentchat isTerminalHttpStatus(); terminal claim
  // refusals are dropped by workers, and this fleet-wide cap leaves no alternate claimer.
  recordProviderCapRefusal(services, { handoff_id, worker_id, decision, path });
  return json(
    {
      error: {
        code: "provider_concurrency_cap",
        message: `handoff ${handoff_id} targets provider ${decision.provider}; provider is at the in-flight dispatch cap`,
      },
      provider: decision.provider,
      max_in_flight: decision.max_in_flight,
      in_flight_count: decision.in_flight_count,
    },
    429,
  );
}

function enforceProviderConcurrencyCap(
  services: DaemonServices,
  handoff: { to_agent: string },
  handoff_id: string,
  worker_id: string,
): { decision: ProviderConcurrencyDecision | null; response?: Response } {
  const decision = resolveProviderConcurrencyDecision(services, handoff);
  if (!decision) return { decision: null };
  if (decision.in_flight_count >= decision.max_in_flight) {
    return {
      decision,
      response: providerConcurrencyCapResponse(
        services,
        handoff_id,
        worker_id,
        decision,
        "precheck",
      ),
    };
  }
  return { decision };
}

function maybeTeardownLongLivedTick(params: {
  services: Services;
  handoff_id: string;
  dispatch_kind: string | null | undefined;
  long_lived_tick_id: string | null | undefined;
  outcome: TickOutcome;
  error?: string;
  resolved_at_iso: string;
}): void {
  if (params.dispatch_kind !== "long_lived_tick") return;
  if (!params.long_lived_tick_id) return;

  try {
    const tick = params.services.db
      .query<
        LongLivedTickRow,
        [string]
      >("SELECT id, agent_id, chain_id, completed_at, outcome FROM long_lived_ticks WHERE id = ?")
      .get(params.long_lived_tick_id);
    if (!tick) return;
    if (tick.completed_at !== null || tick.outcome !== null) return;

    const resolvedAtMs = Date.parse(params.resolved_at_iso);
    const costRows = tick.chain_id
      ? params.services.db
          .query<AgentPerformanceCostRow, [string]>(
            `SELECT cost_usd
             FROM agent_performance
            WHERE conversation_id = ?
              AND source <> 'manual_seed'
              AND cost_usd IS NOT NULL`,
          )
          .all(tick.chain_id)
      : [];
    const totalCostUsd = costRows.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0);
    const cost_cents = costRows.length > 0 ? Math.round(totalCostUsd * 100) : null;
    if (cost_cents === null) {
      params.services.log.warn(
        { handoff_id: params.handoff_id, long_lived_tick_id: params.long_lived_tick_id },
        "long-lived tick teardown could not stamp cost_cents yet",
      );
    }
    handleTickTeardown(params.services.db, {
      tick_id: tick.id,
      agent_id: tick.agent_id,
      outcome: params.outcome,
      error: params.error,
      now: Number.isNaN(resolvedAtMs) ? Date.now() : resolvedAtMs,
      cost_cents: cost_cents ?? undefined,
    });
  } catch (err) {
    params.services.log.warn(
      {
        handoff_id: params.handoff_id,
        long_lived_tick_id: params.long_lived_tick_id,
        err: err instanceof Error ? err.message : String(err),
      },
      "long-lived tick teardown failed during terminal handoff transition",
    );
  }
}

function resolveCreateRoute(
  input: {
    to_role?: string | null;
    message: string;
    chain_task_type?: Parameters<typeof resolveSingleRoute>[3] | null;
  },
  effectiveProfile: PermissionProfile | null,
  services: Services,
): { route: ReturnType<typeof resolveSingleRoute> | null; response: Response | null } {
  try {
    const route = input.to_role
      ? resolveSingleRoute(
          services,
          input.to_role,
          input.message,
          input.chain_task_type ?? undefined,
          // Hints only when the profile applies: passing an object at all
          // engages the model task router (mode !== off), which must stay
          // byte-identical to legacy routing for unprofiled hops.
          effectiveProfile === null ? undefined : { permission_profile: effectiveProfile },
        )
      : null;
    return { route, response: null };
  } catch (err) {
    if (err instanceof RouterHardConstraintExhaustedError) {
      return {
        route: null,
        response: json(
          {
            error: {
              code: "router_hard_constraint_exhausted",
              message: "the model task router excluded every candidate via a hard constraint",
              reasons: err.decision.alternatives
                .filter((alternative) => alternative.excluded)
                .map((alternative) => ({
                  route_id: alternative.routeId,
                  reasons: alternative.reasons,
                })),
            },
          },
          422,
        ),
      };
    }
    if (err instanceof RoutingBiasExhaustedError) {
      return {
        route: null,
        response: json(
          {
            error: {
              code: "routing_bias_exhausted",
              message: "routing biases excluded every candidate for the requested role",
              role: err.role,
              task_type: err.taskType,
            },
          },
          422,
        ),
      };
    }
    throw err;
  }
}

// The create route cannot carry cwd_override at all — it is set only by the
// in-process chain_start path — and a child under a scratch-bound parent is
// rejected outright. What remains to gate is a live scratch-capable worker
// whenever a scratch-bound hop somehow reaches the row level.
function cwdOverrideGateResponse(
  data: {
    cwd_override?: string | null;
    parent_handoff_id?: string | null;
    project_id?: string | null;
  },
  services: Services,
): Response | null {
  return scratchBoundaryGateResponse(data, services);
}

export async function handoffsCreateRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null)
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );

  const parsed = CreateHandoffRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        error: {
          code: "validation_error",
          message: "body failed schema validation",
          field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      },
      400,
    );
  }

  const parentResponse = validateParentHandoff(parsed.data, services);
  if (parentResponse) return parentResponse;

  const depthResponse = enforceRecursionDepthGuard(parsed.data, services);
  if (depthResponse) return depthResponse;

  const effectiveProfile = resolveEffectivePermissionProfile(parsed.data, services);

  const handoff_id = services.uuid();
  const ts = services.clock().toISOString();
  const { route, response: routeResponse } = resolveCreateRoute(
    parsed.data,
    effectiveProfile,
    services,
  );
  if (routeResponse) return routeResponse;
  const routedAgent = route?.agent ?? parsed.data.to;
  const routedRole = route?.role ?? parsed.data.to_role ?? null;
  const routingTaskType = route?.taskType ?? parsed.data.chain_task_type ?? null;

  const profileGateResponse = profiledDispatchGateResponse(
    services,
    routedAgent,
    effectiveProfile,
    parsed.data.project_id ?? null,
  );
  if (profileGateResponse) return profileGateResponse;

  const cwdOverrideResponse = cwdOverrideGateResponse(parsed.data, services);
  if (cwdOverrideResponse) return cwdOverrideResponse;

  // F6: phantom-seat rejection at the chain-HOP write boundary, mirroring the
  // chain_start rejectUnknownAgent shape so the two write paths agree on what
  // counts as a valid seat. Without this, agent-name typos and parse artifacts
  // ("penumbra", stray tokens) silently materialize as handoffs to
  // unroutable agents.
  //
  // Guard: only fires when route is null (the name path — role-routed and
  // forceExact paths already resolve via the registry-aware router) AND when
  // services.agentRegistry is populated. A null/empty registry is treated as
  // "config unavailable" and we let the request through rather than wedge
  // every hop during a brief config-reload race.
  const registry = (services as Services & { agentRegistry?: string[] | null }).agentRegistry;
  if (route === null && registry && registry.length > 0 && !registry.includes(routedAgent)) {
    const nearest = getNearestAgents(routedAgent, registry);
    services.log.warn(
      {
        event: "handoffs_create.unknown_agent",
        initial_agent: routedAgent,
        from: parsed.data.from,
        conversation_id: parsed.data.conversation_id,
        registry_size: registry.length,
        nearest,
      },
      "handoff-create unknown agent rejected",
    );
    return json(
      {
        error: {
          code: "unknown_agent",
          agent: routedAgent,
          did_you_mean: nearest,
          hint: "use chain.list_agents to enumerate valid agents",
        },
      },
      400,
    );
  }

  // Single transaction: write t0 'agent-handoff' event AND the handoffs row.
  services.db.transaction(() => {
    services.t0Writer.write({
      event_id: handoff_id,
      ts,
      ingest_ts: ts,
      source: "mcp",
      source_detail: "agent-handoff",
      project_id: parsed.data.project_id ?? null,
      user_id: parsed.data.from,
      machine_id: services.machineId.get(),
      session_id: parsed.data.conversation_id,
      event_type: "agent-handoff",
      lane: "unknown",
      provider: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      latency_ms: null,
      request_id: null,
      origin: null,
      payload_json: {
        from: parsed.data.from,
        to: routedAgent,
        mentioned_as: routedRole ? "role" : "name",
        routed_role: routedRole,
        message_excerpt: parsed.data.message.slice(0, 240),
        triggered_by_event_id: parsed.data.triggered_by_event_id,
      },
      payload_summary: parsed.data.message.slice(0, 240),
    });

    services.handoffWriter.create({
      handoff_id,
      ts,
      from: parsed.data.from,
      to: routedAgent,
      to_role: routedRole,
      message: parsed.data.message,
      conversation_id: parsed.data.conversation_id,
      project_id: parsed.data.project_id ?? null,
      triggered_by_event_id: parsed.data.triggered_by_event_id,
      use_worktree: parsed.data.use_worktree ?? undefined,
      isolated_install: parsed.data.isolated_install ?? undefined,
      chain_task_type: routingTaskType,
      parent_handoff_id: parsed.data.parent_handoff_id ?? null,
      branch_base: parsed.data.branch_base ?? null,
      chain_max_hops: parsed.data.chain_max_hops ?? null,
      permission_profile: effectiveProfile,
      caller_cwd: resolveEffectiveCallerCwd(parsed.data, services),
      cwd_override: null,
    });
  })();

  return json({
    handoff_id,
    status: "pending",
    ...(route
      ? {
          routed_agent: route.agent,
          routed_role: route.role,
          routing_task_type: route.taskType,
        }
      : {}),
  });
}

function validateParentHandoff(
  input: {
    parent_handoff_id?: string | null;
    conversation_id: string;
  },
  services: Services,
): Response | null {
  if (!input.parent_handoff_id) return null;
  const parent = services.handoffReader.get(input.parent_handoff_id);
  if (!parent) {
    return json(
      {
        error: {
          code: "parent_not_found",
          message: `parent handoff ${input.parent_handoff_id} was not found`,
        },
      },
      404,
    );
  }
  if (parent.conversation_id !== input.conversation_id) {
    return json(
      {
        error: {
          code: "parent_conversation_mismatch",
          message: "parent handoff belongs to a different conversation",
        },
      },
      409,
    );
  }
  return null;
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

type WorkerAuthz = { project_id?: string; isolation: ExtraWorkerConfig["isolation"] };

function validateProjectScopeQuery(
  projectIdParam: string | null,
  projectScopeParam: string | null,
): Response | null {
  if (projectIdParam !== null && projectScopeParam !== null) {
    return json(
      {
        error: {
          code: "validation_error",
          message: "project_id and project_scope are mutually exclusive",
        },
      },
      400,
    );
  }
  if (projectScopeParam !== null && projectScopeParam !== "global") {
    return json(
      {
        error: {
          code: "validation_error",
          message: `unsupported project_scope: ${projectScopeParam}`,
        },
      },
      400,
    );
  }
  return null;
}

function resolveProjectIdFromParams(
  projectIdParam: string | null,
  projectScopeParam: string | null,
  services: DaemonServices,
): { project_id: string | null | undefined; error?: Response } {
  let project_id: string | null | undefined;
  if (projectIdParam !== null) {
    if (projectIdParam.trim() === "") {
      return {
        project_id,
        error: json(
          { error: { code: "validation_error", message: "project_id must not be empty" } },
          400,
        ),
      };
    }
    if (projectIdParam === NULL_PROJECT_ID_SENTINEL) {
      services.log.warn(
        { event: "deprecated_null_sentinel", recommend: "project_scope=global" },
        "deprecated null project_id sentinel; prefer project_scope=global",
      );
      project_id = null;
    } else {
      project_id = projectIdParam;
    }
    if (
      services.projectRegistry &&
      project_id !== null &&
      !services.projectRegistry.has(project_id)
    ) {
      return { project_id, error: json({ error: { code: "unknown_project", project_id } }, 400) };
    }
  } else if (projectScopeParam === "global") {
    project_id = null;
  }
  return { project_id };
}

function applyAuthzProjectScope(
  project_id: string | null | undefined,
  authz: WorkerAuthz | undefined,
): { project_id: string | null | undefined; error?: Response } {
  if (authz?.isolation !== "hard") return { project_id };
  if (authz.project_id === undefined) {
    return {
      project_id,
      error: json(
        {
          error: {
            code: "project_mismatch",
            message: "hard-isolated worker missing configured project_id",
          },
        },
        403,
      ),
    };
  }
  if (project_id === undefined) {
    return { project_id: authz.project_id };
  }
  if (project_id !== authz.project_id) {
    return {
      project_id,
      error: json(
        {
          error: {
            code: "project_mismatch",
            message: `handoff list scope ${String(project_id)} does not match worker scope ${authz.project_id}`,
            project_id: authz.project_id,
          },
        },
        403,
      ),
    };
  }
  return { project_id };
}

function parseStatusListParam(statusParam: string): { statuses?: string[]; error?: Response } {
  const statuses = statusParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (statuses.length === 0) {
    return {
      error: json({ error: { code: "validation_error", message: "status is empty" } }, 400),
    };
  }
  for (const s of statuses) {
    if (!VALID_STATUSES.has(s)) {
      return {
        error: json({ error: { code: "validation_error", message: `unknown status: ${s}` } }, 400),
      };
    }
  }
  return { statuses };
}

function handoffsListPendingWithStatus(
  statusParam: string,
  sinceParam: string | null,
  conv: string | undefined,
  project_id: string | null | undefined,
  services: DaemonServices,
  agentParam: string | null,
): Response {
  const parsed = parseStatusListParam(statusParam);
  if (parsed.error) return parsed.error;
  const statuses = parsed.statuses ?? [];

  if (statuses.length === 1 && statuses[0] === "completed" && sinceParam !== null) {
    if (!sinceParam || Number.isNaN(Date.parse(sinceParam))) {
      return json(
        { error: { code: "validation_error", message: "since must be an ISO timestamp" } },
        400,
      );
    }
    const sinceUtc = new Date(sinceParam).toISOString();
    const done = services.handoffReader.countCompletedSince({
      since: sinceUtc,
      conversation_id: conv,
      project_id,
      to_agent: agentParam ?? undefined,
    });
    return json({ done });
  }
  const handoffs = services.handoffReader
    .listByStatus({
      statuses: statuses as HandoffStatus[],
      conversation_id: conv,
      project_id,
      to_agent: agentParam ?? undefined,
    })
    .map(coerceHandoffBooleans);
  return json({ handoffs });
}

export function handoffsListPendingRoute(req: Request, services: DaemonServices): Response {
  const url = new URL(req.url);
  const conv = url.searchParams.get("conversation_id") ?? undefined;
  const statusParam = url.searchParams.get("status");
  const sinceParam = url.searchParams.get("since");
  const projectIdParam = url.searchParams.get("project_id");
  const projectScopeParam = url.searchParams.get("project_scope");
  const agentParam = url.searchParams.get("agent");
  const scopeError = validateProjectScopeQuery(projectIdParam, projectScopeParam);
  if (scopeError) return scopeError;

  if (agentParam === "") {
    return json({ error: { code: "validation_error", message: "agent must be non-empty" } }, 400);
  }

  const principal = getPrincipal(req);
  const authz =
    principal?.kind === "worker" ? services.workerAuthz?.get(principal.worker_id) : undefined;

  const resolvedProject = resolveProjectIdFromParams(projectIdParam, projectScopeParam, services);
  if (resolvedProject.error) return resolvedProject.error;
  const scopedProject = applyAuthzProjectScope(resolvedProject.project_id, authz);
  if (scopedProject.error) return scopedProject.error;
  const project_id = scopedProject.project_id;

  if (statusParam !== null) {
    return handoffsListPendingWithStatus(
      statusParam,
      sinceParam,
      conv,
      project_id,
      services,
      agentParam,
    );
  }

  // No status param: back-compat — pending only
  const pendingOpts: {
    conversation_id?: string;
    to_agent?: string;
    project_id?: string | null;
  } = {
    conversation_id: conv,
    to_agent: agentParam ?? undefined,
    project_id,
  };
  const handoffs = services.handoffReader.listPending(pendingOpts).map(coerceHandoffBooleans);
  return json({ handoffs });
}

export function handoffsLatestRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const conversation_id = url.searchParams.get("conversation_id");
  if (!conversation_id) {
    return json(
      { error: { code: "missing_param", message: "conversation_id query parameter is required" } },
      400,
    );
  }
  const handoff = services.handoffReader.getLatestForConversation(conversation_id);
  if (!handoff) {
    return json(
      { error: { code: "not_found", message: "no handoffs found for conversation" } },
      404,
    );
  }
  return json({ handoff });
}

export async function handoffsApproveRoute(
  req: Request,
  handoff_id: string,
  services: Services,
): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null)
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );
  const parsed = ApproveHandoffRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        error: {
          code: "validation_error",
          field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      },
      400,
    );
  }
  const ts = services.clock().toISOString();
  try {
    if (parsed.data.reject) {
      services.handoffWriter.reject(handoff_id, {
        resolved_by: parsed.data.resolved_by ?? services.machineId.get(),
        resolved_at: ts,
        reason: parsed.data.reason,
      });
      const rejected = services.handoffReader.get(handoff_id);
      if (rejected) {
        maybeTeardownLongLivedTick({
          services,
          handoff_id,
          dispatch_kind: rejected.dispatch_kind,
          long_lived_tick_id: rejected.long_lived_tick_id,
          outcome: "failed",
          error: parsed.data.reason ?? "rejected",
          resolved_at_iso: ts,
        });
      }
      return json({ handoff_id, status: "rejected" });
    }
    const result = services.handoffWriter.approve(handoff_id, {
      resolved_by: parsed.data.resolved_by ?? services.machineId.get(),
      resolved_at: ts,
      redirect_to: parsed.data.redirect_to,
    });
    return json({ handoff_id, status: result.status, redirected_to: result.redirected_to });
  } catch (err) {
    const cur = services.handoffReader.get(handoff_id);
    if (!cur)
      return json(
        { error: { code: "not_found", message: `handoff ${handoff_id} does not exist` } },
        404,
      );
    if (cur.status !== "pending") {
      return json(
        {
          error: {
            code: "conflict",
            message: `handoff ${handoff_id} is ${cur.status}, not pending`,
          },
          current_status: cur.status,
        },
        409,
      );
    }
    services.log.warn({ handoff_id, err: String(err) }, "handoff approve/reject failed");
    return json(
      { error: { code: "internal_error", message: String(err) }, current_status: cur.status },
      500,
    );
  }
}

function enforceClaimSpreadCap(
  services: DaemonServices,
  handoff: {
    dispatch_kind?: string | null;
    workflow_run_id?: string | null;
    project_id: string | null;
    to_agent: string;
  },
  worker_id: string,
  handoff_id: string,
): { decision: ClaimSpreadDecision | null; response?: Response } {
  const decision = resolveClaimSpreadDecision(services, handoff, worker_id);
  if (
    decision &&
    countWorkflowGroupClaimsForWorker(services, decision.workflow_run_id, worker_id) >=
      decision.max_per_worker
  ) {
    return { decision, response: claimSpreadCapResponse(handoff_id, decision) };
  }
  return { decision };
}

function recordClaimDispatchEvent(
  services: DaemonServices,
  handoff_id: string,
  worker_id: string,
): void {
  const claimedRoot = services.db
    .query<
      { root_handoff_id: string | null },
      [string]
    >(`SELECT root_handoff_id FROM handoffs WHERE handoff_id = ?`)
    .get(handoff_id);
  if (!claimedRoot) return;
  const perRootTop3 = services.db
    .query<{ root_handoff_id: string; in_flight_count: number }, []>(
      `SELECT root_handoff_id, COUNT(*) AS in_flight_count
       FROM handoffs
       WHERE status='dispatched'
       GROUP BY root_handoff_id
       ORDER BY in_flight_count DESC, root_handoff_id ASC
       LIMIT 3`,
    )
    .all();
  services.dispatchEventLog.record({
    handoff_id,
    worker_id,
    source: "daemon",
    kind: "claim",
    ts: services.clock().toISOString(),
    meta: {
      root_handoff_id: claimedRoot.root_handoff_id ?? handoff_id,
      per_root_top3: perRootTop3,
    },
  });
}

function buildClaimConflictResponse(
  services: DaemonServices,
  handoff_id: string,
  worker_id: string,
  spreadDecision: ClaimSpreadDecision | null,
  providerDecision: ProviderConcurrencyDecision | null,
): Response {
  const after = services.handoffReader.get(handoff_id);
  if (
    spreadDecision &&
    after &&
    (after.status === "approved" || after.status === "redirected") &&
    countWorkflowGroupClaimsForWorker(services, spreadDecision.workflow_run_id, worker_id) >=
      spreadDecision.max_per_worker
  ) {
    return claimSpreadCapResponse(handoff_id, spreadDecision);
  }
  if (providerDecision && after && (after.status === "approved" || after.status === "redirected")) {
    const in_flight_count = countProviderInFlight(services, providerDecision.providerSeatNames);
    if (in_flight_count >= providerDecision.max_in_flight) {
      return providerConcurrencyCapResponse(
        services,
        handoff_id,
        worker_id,
        { ...providerDecision, in_flight_count },
        "cas_loss",
      );
    }
  }
  return json(
    {
      error: {
        code: "conflict",
        message: `handoff ${handoff_id} cannot be claimed (status=${after?.status ?? "unknown"})`,
      },
      current_status: after?.status ?? null,
    },
    409,
  );
}

// Profile enforcement and scratch-worktree support are both
// registration-declared capabilities; a handoff requiring either stays
// unclaimed rather than run unconstrained.
function claimCapabilityGateResponse(
  services: DaemonServices,
  cur: { permission_profile?: PermissionProfile | null; cwd_override?: string | null },
  workerId: string,
  tokenHash: string,
): Response | null {
  if (
    cur.permission_profile !== null &&
    cur.permission_profile !== undefined &&
    !workerDeclaresProfileEnforcement(services, tokenHash, cur.permission_profile)
  ) {
    return json(
      {
        error: {
          code: "permission_profile_unenforceable",
          message: `worker '${workerId}' does not enforce permission_profile '${cur.permission_profile}'`,
          worker_id: workerId,
          permission_profile: cur.permission_profile,
        },
      },
      403,
    );
  }
  if (
    cur.cwd_override !== null &&
    cur.cwd_override !== undefined &&
    !workerDeclaresScratchSupport(services, tokenHash)
  ) {
    return json(
      {
        error: {
          code: "scratch_worker_not_capable",
          message: `worker '${workerId}' does not declare scratch-worktree support`,
          worker_id: workerId,
        },
      },
      403,
    );
  }
  return null;
}

export async function handoffsClaimRoute(
  req: Request,
  handoff_id: string,
  services: DaemonServices,
): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null)
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );

  const body = z.object({ worker_id: z.string().min(1) }).safeParse(raw);
  if (!body.success) {
    return json(
      {
        error: {
          code: "validation_error",
          message: "body failed schema validation",
          field_errors: body.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      },
      400,
    );
  }

  const principalErr = requireWorkerPrincipalMatch(req, body.data.worker_id);
  if (principalErr !== null) return principalErr;
  const principal = getPrincipal(req);
  if (principal?.kind !== "worker") {
    return json(
      { error: { code: "worker_token_required", message: "claim requires a worker token" } },
      403,
    );
  }

  const cur = services.handoffReader.get(handoff_id);
  if (!cur)
    return json(
      { error: { code: "not_found", message: `handoff ${handoff_id} does not exist` } },
      404,
    );

  const authz = services.workerAuthz?.get(body.data.worker_id);
  if (
    authz?.isolation === "hard" &&
    authz.project_id !== undefined &&
    cur.project_id !== authz.project_id
  ) {
    return json(
      {
        error: {
          code: "project_mismatch",
          message: `handoff ${handoff_id} belongs to project ${String(cur.project_id)}`,
          project_id: authz.project_id,
        },
      },
      403,
    );
  }

  // A profiled or scratch-routed handoff may only be claimed by a worker
  // that declared the matching capability at registration; otherwise it must
  // stay unclaimed rather than run unconstrained.
  const capabilityGate = claimCapabilityGateResponse(
    services,
    cur,
    body.data.worker_id,
    principal.token_hash,
  );
  if (capabilityGate) return capabilityGate;

  const cap = enforceClaimSpreadCap(services, cur, body.data.worker_id, handoff_id);
  if (cap.response) return cap.response;
  const spreadDecision = cap.decision;

  const providerCap = enforceProviderConcurrencyCap(services, cur, handoff_id, body.data.worker_id);
  if (providerCap.response) return providerCap.response;
  const providerDecision = providerCap.decision;

  const won = services.handoffWriter.claimDispatch(handoff_id, body.data.worker_id, {
    workflow_run_id: spreadDecision?.workflow_run_id,
    maxWorkflowSiblingsPerWorker: spreadDecision?.max_per_worker,
    providerSeatNames: providerDecision?.providerSeatNames,
    maxProviderInFlight: providerDecision?.max_in_flight,
  });
  if (!won) {
    return buildClaimConflictResponse(
      services,
      handoff_id,
      body.data.worker_id,
      spreadDecision,
      providerDecision,
    );
  }

  recordClaimDispatchEvent(services, handoff_id, body.data.worker_id);
  return json({ handoff_id, status: "dispatched" });
}

export async function handoffsRecordBranchRoute(
  req: Request,
  handoff_id: string,
  services: DaemonServices,
): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) {
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );
  }

  const body = z
    .object({
      worker_id: z.string().min(1),
      branch_name: z.string().min(1),
    })
    .safeParse(raw);
  if (!body.success) {
    return json(
      {
        error: {
          code: "validation_error",
          message: "body failed schema validation",
          field_errors: body.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      },
      400,
    );
  }

  const principalErr = requireWorkerPrincipalMatch(req, body.data.worker_id);
  if (principalErr !== null) return principalErr;

  const cur = services.handoffReader.get(handoff_id);
  if (!cur) {
    return json(
      { error: { code: "not_found", message: `handoff ${handoff_id} does not exist` } },
      404,
    );
  }

  services.handoffWriter.recordBranchName(handoff_id, body.data.branch_name);
  return json({ handoff_id, branch_name: body.data.branch_name });
}

type ResolvedExpectedWorker =
  | { kind: "ok"; expected_worker_id: string | undefined }
  | { kind: "mismatch" };

function resolveExpectedWorkerForCompletion(
  req: Request,
  body: ReturnType<ReturnType<typeof z.object>["safeParse"]>,
): ResolvedExpectedWorker {
  const principal = getPrincipal(req);
  if (principal?.kind === "worker") {
    if (
      body.success &&
      (body.data as { worker_id?: string }).worker_id !== undefined &&
      (body.data as { worker_id?: string }).worker_id !== principal.worker_id
    ) {
      return { kind: "mismatch" };
    }
    return { kind: "ok", expected_worker_id: principal.worker_id };
  }
  return {
    kind: "ok",
    expected_worker_id: body.success ? (body.data as { worker_id?: string }).worker_id : undefined,
  };
}

function completeCancelFallback(services: Services, handoff_id: string): Response {
  const cancelledAtIso = services.clock().toISOString();
  services.handoffWriter.markFailed(handoff_id, {
    reason: "cancelled",
    resolved_by: "cancel",
    ts: cancelledAtIso,
  });
  const cancelled = services.handoffReader.get(handoff_id);
  if (cancelled) {
    maybeTeardownLongLivedTick({
      services,
      handoff_id,
      dispatch_kind: cancelled.dispatch_kind,
      long_lived_tick_id: cancelled.long_lived_tick_id,
      outcome: "failed",
      error: "cancelled",
      resolved_at_iso: cancelledAtIso,
    });
  }
  return json({ handoff_id, status: "failed", reason: "cancelled" });
}

export async function handoffsCompleteRoute(
  _req: Request,
  handoff_id: string,
  services: Services,
): Promise<Response> {
  // Atomic: try the dispatched→completed transition first, then explain the failure if it didn't happen.
  const raw = await safeJson(_req);
  const body = z.object({ worker_id: z.string().optional() }).safeParse(raw);

  const resolved = resolveExpectedWorkerForCompletion(_req, body);
  if (resolved.kind === "mismatch") {
    return json(
      {
        error: {
          code: "worker_id_mismatch",
          message: "body worker_id disagrees with credential",
        },
      },
      403,
    );
  }

  const completedAtIso = services.clock().toISOString();
  const won = services.handoffWriter.markCompleted(handoff_id, {
    ts: completedAtIso,
    expected_worker_id: resolved.expected_worker_id,
  });
  if (won) {
    const completed = services.handoffReader.get(handoff_id);
    if (completed) {
      maybeTeardownLongLivedTick({
        services,
        handoff_id,
        dispatch_kind: completed.dispatch_kind,
        long_lived_tick_id: completed.long_lived_tick_id,
        outcome: "success",
        resolved_at_iso: completedAtIso,
      });
    }
    return json({ handoff_id, status: "completed" });
  }
  const cur = services.handoffReader.get(handoff_id);
  if (!cur)
    return json(
      { error: { code: "not_found", message: `handoff ${handoff_id} does not exist` } },
      404,
    );
  if (cur.status === "dispatched" && cur.cancel_requested_at !== null) {
    return completeCancelFallback(services, handoff_id);
  }
  return json(
    {
      error: {
        code: "conflict",
        message: `handoff ${handoff_id} is ${cur.status}, not dispatched`,
      },
      current_status: cur.status,
    },
    409,
  );
}

export function handoffsGetRoute(_req: Request, handoff_id: string, services: Services): Response {
  const handoff = services.handoffReader.get(handoff_id);
  if (!handoff) {
    return json({ error: { code: "not_found", message: `handoff ${handoff_id} not found` } }, 404);
  }
  return json({ handoff });
}

export function handoffsStatusRoute(
  _req: Request,
  handoff_id: string,
  services: Services,
): Response {
  const row = services.handoffReader.get(handoff_id);
  if (!row) {
    return json({ error: { code: "not_found", message: `handoff not found: ${handoff_id}` } }, 404);
  }

  const started_at = row.ts;
  const terminal =
    row.status === "completed" ||
    row.status === "failed" ||
    row.status === "rejected" ||
    row.status === "expired";
  const resolved_at = terminal ? (row.resolved_at ?? null) : null;
  const latency_seconds =
    resolved_at && started_at
      ? Math.round((new Date(resolved_at).getTime() - new Date(started_at).getTime()) / 1000)
      : null;
  const error_summary =
    row.status === "failed" && row.resolution_reason
      ? (row.resolution_reason.split("\n")[0]?.slice(0, 200) ?? null)
      : null;
  const reliability = buildDispatchAuditReportForHandoff(services, row);

  return json({
    handoff_id,
    status: row.status,
    error_summary,
    branch_name: row.branch_name ?? null,
    worker_id: row.worker_id ?? null,
    started_at,
    resolved_at,
    latency_seconds,
    reliability: {
      status: reliability.status,
      trustworthy: reliability.trustworthy,
      recommended_action: reliability.recommended_action,
      summary: reliability.summary,
    },
  });
}

export async function handoffsFailRoute(
  req: Request,
  handoff_id: string,
  services: Services,
): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null)
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );

  const body = HandoffFailRequestSchema.safeParse(raw);
  if (!body.success) {
    return json(
      {
        error: {
          code: "validation_error",
          message: "body failed schema validation",
          field_errors: body.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      },
      400,
    );
  }

  const principal = getPrincipal(req);
  let expected_worker_id: string | undefined;
  if (principal?.kind === "worker") {
    if (body.data.worker_id !== undefined && body.data.worker_id !== principal.worker_id) {
      return json(
        {
          error: {
            code: "worker_id_mismatch",
            message: "body worker_id disagrees with credential",
          },
        },
        403,
      );
    }
    expected_worker_id = principal.worker_id;
  } else {
    expected_worker_id = body.data.worker_id;
  }

  const ts = services.clock().toISOString();
  const won = services.handoffWriter.markFailed(handoff_id, {
    reason: body.data.reason,
    ts,
    resolved_by: services.machineId.get(),
    expected_worker_id,
  });

  if (won) {
    const failed = services.handoffReader.get(handoff_id);
    if (failed) {
      maybeTeardownLongLivedTick({
        services,
        handoff_id,
        dispatch_kind: failed.dispatch_kind,
        long_lived_tick_id: failed.long_lived_tick_id,
        outcome: "failed",
        error: body.data.reason,
        resolved_at_iso: ts,
      });
    }
    return json({ handoff_id, status: "failed" });
  }

  const cur = services.handoffReader.get(handoff_id);
  if (!cur)
    return json(
      { error: { code: "not_found", message: `handoff ${handoff_id} does not exist` } },
      404,
    );
  return json(
    {
      error: {
        code: "conflict",
        message: `handoff ${handoff_id} is ${cur.status}, cannot be failed`,
      },
      current_status: cur.status,
    },
    409,
  );
}
