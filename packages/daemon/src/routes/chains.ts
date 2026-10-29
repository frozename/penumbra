import {
  type ChainRoutingAdvisory,
  type ChainRoutingWarning,
  ChainStartResponseSchema,
} from "@penumbra/api-contract";
import { WORKLOADS } from "@penumbra/config";
import {
  agentEnforcesPermissionProfile,
  type AgentRecommendation,
  type AgentTaskType,
  buildHandoffBranchName,
  type CapCheckRefuse,
  type ChainStartRequest,
  ChainStartRequestSchema,
  checkPressureCap,
  deriveBranchNameFromMessage,
  HandoffStatusSchema,
  inferAgentTaskTypeForRole,
  insertLane,
  inspectPromptVsProject,
  MaestroSessionWriter,
  PERMISSION_PROFILE_REVIEW_READONLY,
  PERMISSION_PROFILES,
  type PermissionProfile,
  RecallRequestSchema,
  type RecallResult,
  resolveBiasEffect,
  resolveProvider,
  routeAgent,
  type RoutingBias,
  type RoutingDecision,
  type Services,
  slugifyBranchSegment,
  type TaskClass,
  writeRoutingDecision,
} from "@penumbra/core";
import { z } from "zod";

import { autoRecallForDispatch } from "../dispatch/auto-recall.js";
import { stampPrompt } from "../long-lived/prompt-stamper.js";
import { supportsMidSessionInject } from "../maestro/acp-injector.js";
import { buildProviderCaps } from "../maestro/build-provider-caps.js";
import { enforceMaestroBudget } from "../maestro/chain-budget-gate.js";
import { json } from "./_helpers.js";
import { availableBranchNameBestEffort } from "./chains-branch-precheck.js";
import {
  readActiveRoutingBiases,
  resolveSingleRoute,
  type RouterDecisionSink,
  RouterHardConstraintExhaustedError,
  RoutingBiasExhaustedError,
} from "./role-routing.js";
import {
  profiledLiveWorkerGateResponse,
  scratchLiveWorkerGateResponse,
} from "./worker-profile-gate.js";
interface InitialRoute {
  agent: string;
  role: string | null;
  taskType: AgentTaskType | null;
}

interface RouteResolution {
  route: InitialRoute | null;
  decision: RoutingDecision | null;
  roleRouteAttempted: boolean;
}

interface RouterHarnessHints {
  taskClass?: string;
  projectId?: string;
  dispatchKind?: string;
  tool_free?: boolean;
  permission_profile?: PermissionProfile;
}

type AgentChatConfigLike = {
  agents?: {
    name: string;
    adapter?: string;
    enforces_permission_profiles?: readonly string[];
    pricing_mode?: "api" | "subscription";
    subscription_provider?: string;
    subscription_model?: string;
    api_provider?: string;
  }[];
};

type ChainStartRequestWithLongLived = Omit<ChainStartRequest, "dispatch_kind"> & {
  open_pr_on_review?: boolean;
  dispatch_kind?: DispatchKind;
  workflow_run_id?: string;
  long_lived_agent_id?: string;
  long_lived_tick_id?: string;
  task_class?: TaskClass;
  workload?: Workload;
  isolated_install?: boolean;
};
type Workload = (typeof WORKLOADS)[number];

type DispatchKind = NonNullable<ChainStartRequest["dispatch_kind"]>;
const DISPATCH_KIND_SET = {
  long_lived_tick: true,
  workflow: true,
  thought_analyzer: true,
  orchestrate: true,
} satisfies Record<DispatchKind, true>;
const DISPATCH_KIND_ERROR_LIST = Object.keys(DISPATCH_KIND_SET)
  .map((kind) => `'${kind}'`)
  .join(", ");

interface LongLivedPromptAgentRow {
  id: string;
  display_name: string;
  standing_brief: string;
  working_memory_json: string;
  mcp_allowlist_json: string;
  bounds_wall_clock_ms: number | null;
  bounds_cost_cents: number | null;
  bounds_max_sub_dispatches: number | null;
}

interface LongLivedPromptTickRow {
  id: string;
  agent_id: string;
  trigger_kind: "cron" | "event" | "injected_goal" | "manual";
  trigger_payload_json: string | null;
}

const MAX_SUB_DISPATCH_FALLBACKS = 2;

type RoutingWarningPayload = ChainRoutingWarning;

type RoutingAdvisoryPayload = ChainRoutingAdvisory;

function collectSyntheticCaps(
  services: Services,
): Record<string, { max_dispatches: number; window_seconds: number }> {
  const syntheticCaps: Record<string, { max_dispatches: number; window_seconds: number }> = {};
  for (const quota of services.providerQuotas) {
    if (quota.synthetic_cap) syntheticCaps[quota.provider] = quota.synthetic_cap;
  }
  return syntheticCaps;
}

function workerHeartbeatGuard(services: Services): Response | null {
  const timeoutMsStr = process.env.PENUMBRA_WORKER_HEARTBEAT_TIMEOUT_MS;
  const timeoutMs = timeoutMsStr ? parseInt(timeoutMsStr, 10) : 15000;
  if (services.watchdog.hasActiveWorker(timeoutMs)) return null;
  const staleHeartbeats = services.watchdog.getStaleHeartbeatAges(timeoutMs);
  if (staleHeartbeats.length > 0) {
    return json(
      {
        error: {
          code: "worker_heartbeats_stale",
          message: "agentchat-workers are registered but their heartbeats are stale",
          workers: staleHeartbeats,
        },
      },
      503,
    );
  }
  return json(
    {
      error: {
        code: "no_worker_registered",
        message:
          "no agentchat-worker registered; start one via 'bun packages/agentchat/bin/agentchat-worker.ts --storage-root <root>'",
      },
    },
    503,
  );
}

function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function renderProjectBriefInjectedText(briefMd: string): string | null {
  const brief = briefMd.trim();
  if (brief.length === 0) return null;
  return ["## Project brief", "", brief].join("\n");
}

// F3c counter: process-local count of use_worktree dispatches that omitted
// task_class. Module-scoped state is the cheapest seam that's still readable
// from tests; intentionally NOT persisted (instrumentation, not enforcement).
let legacyNoTaskClassUseWorktreeCounter = 0;

function incrementLegacyNoTaskClassUseWorktreeCounter(): void {
  legacyNoTaskClassUseWorktreeCounter += 1;
}

export function getLegacyNoTaskClassUseWorktreeCounter(): number {
  return legacyNoTaskClassUseWorktreeCounter;
}

export function __resetLegacyNoTaskClassUseWorktreeCounterForTest(): void {
  legacyNoTaskClassUseWorktreeCounter = 0;
}

type LongLivedTickExemptionResult =
  | { ok: true; tick: { id: string; agent_id: string } }
  | { ok: false; reason: string };

export function resolveLongLivedTickExemption(
  services: Services,
  input: {
    dispatch_kind?: DispatchKind;
    long_lived_tick_id?: string | null;
    long_lived_agent_id?: string | null;
  },
): LongLivedTickExemptionResult {
  if (input.dispatch_kind !== "long_lived_tick") {
    return { ok: false, reason: "dispatch_kind_mismatch" };
  }
  if (!input.long_lived_tick_id) {
    return { ok: false, reason: "missing_long_lived_tick_id" };
  }
  if (!input.long_lived_agent_id) {
    return { ok: false, reason: "missing_long_lived_agent_id" };
  }
  const tick = services.db
    .query<
      { id: string; agent_id: string },
      [string]
    >(`SELECT id, agent_id FROM long_lived_ticks WHERE id = ? AND completed_at IS NULL LIMIT 1`)
    .get(input.long_lived_tick_id);
  if (!tick) {
    return { ok: false, reason: "unknown_or_completed_long_lived_tick" };
  }
  if (tick.agent_id !== input.long_lived_agent_id) {
    return { ok: false, reason: "long_lived_agent_id_mismatch" };
  }
  return { ok: true, tick };
}

function resolveWorkflowDispatchExemption(
  services: Services,
  input: {
    dispatch_kind?: DispatchKind;
    workflow_run_id?: string | null;
    project_id?: string | null;
  },
): { ok: true; workflow_run_id: string } | { ok: false; reason: string } {
  if (input.dispatch_kind !== "workflow") {
    return { ok: false, reason: "dispatch_kind_mismatch" };
  }
  if (!input.workflow_run_id || !services.workflowRuns) {
    return { ok: false, reason: "missing_workflow_run_id" };
  }
  const info = services.workflowRuns.verify(input.workflow_run_id);
  if (!info) return { ok: false, reason: "unknown_workflow_run_id" };
  if (
    input.project_id !== null &&
    input.project_id !== undefined &&
    info.project_id !== null &&
    info.project_id !== input.project_id
  ) {
    return { ok: false, reason: "workflow_project_id_mismatch" };
  }
  return { ok: true, workflow_run_id: input.workflow_run_id };
}

function longestCommonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr: number[] = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const above = prev[j] ?? 0;
      const left = curr[j - 1] ?? 0;
      const diag = prev[j - 1] ?? 0;
      curr[j] = Math.min(above + 1, left + 1, diag + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 0;
}

export function getNearestAgents(initialAgent: string, registry: string[]): string[] {
  const seen = new Set<string>();
  const lowerInitial = initialAgent.toLowerCase();
  const add = (name: string): void => {
    if (!seen.has(name)) seen.add(name);
  };

  for (const name of registry) {
    if (name.toLowerCase() === lowerInitial) add(name);
  }
  for (const name of registry) {
    const lowerName = name.toLowerCase();
    if (lowerName.includes(lowerInitial) || lowerInitial.includes(lowerName)) add(name);
  }

  const scored = registry
    .map((name) => ({
      name,
      distance: editDistance(lowerInitial, name.toLowerCase()),
      prefix: longestCommonPrefix(lowerInitial, name.toLowerCase()),
    }))
    .sort((a, b) => a.distance - b.distance || b.prefix - a.prefix || a.name.localeCompare(b.name));
  for (const entry of scored) add(entry.name);
  return [...seen].slice(0, 3);
}

function resolveThoughtAnalyzerDispatchExemption(input: {
  dispatch_kind?: DispatchKind;
}): { ok: true } | { ok: false; reason: string } {
  if (input.dispatch_kind !== "thought_analyzer") {
    return { ok: false, reason: "dispatch_kind_mismatch" };
  }
  return { ok: true };
}

function canBypassExplicitProjectIdGate(
  input: ChainStartRequestWithLongLived,
  services: Services,
): boolean {
  const longLivedExemption = resolveLongLivedTickExemption(services, input);
  if (longLivedExemption.ok) return true;
  const workflowExemption = resolveWorkflowDispatchExemption(services, input);
  if (workflowExemption.ok) return true;
  const thoughtAnalyzerExemption = resolveThoughtAnalyzerDispatchExemption(input);
  return thoughtAnalyzerExemption.ok;
}

function validationErrorResponse(field_errors: { path: string[]; message: string }[]): Response {
  return json(
    {
      error: {
        code: "validation_error",
        message: "body failed schema validation",
        field_errors,
      },
    },
    400,
  );
}

interface ChainStartExtraFields {
  openPrOnReview: boolean | undefined;
  dispatchKind: DispatchKind | undefined;
  longLivedAgentId: string | undefined;
  longLivedTickId: string | undefined;
  workflowRunId: string | undefined;
  workload: Workload | undefined;
}

function parseChainStartExtraFields(
  raw: unknown,
): { ok: true; fields: ChainStartExtraFields } | { ok: false; response: Response } {
  const openPr = readOptionalBooleanField(raw, "open_pr_on_review");
  if (openPr.error)
    return {
      ok: false,
      response: validationErrorResponse([{ path: ["open_pr_on_review"], message: openPr.error }]),
    };
  const dispatchKind = readOptionalDispatchKindField(raw, "dispatch_kind");
  if (dispatchKind.error)
    return {
      ok: false,
      response: validationErrorResponse([{ path: ["dispatch_kind"], message: dispatchKind.error }]),
    };
  const longLivedAgentId = readOptionalStringField(raw, "long_lived_agent_id");
  if (longLivedAgentId.error)
    return {
      ok: false,
      response: validationErrorResponse([
        { path: ["long_lived_agent_id"], message: longLivedAgentId.error },
      ]),
    };
  const longLivedTickId = readOptionalStringField(raw, "long_lived_tick_id");
  if (longLivedTickId.error)
    return {
      ok: false,
      response: validationErrorResponse([
        { path: ["long_lived_tick_id"], message: longLivedTickId.error },
      ]),
    };
  const workflowRunId = readOptionalStringField(raw, "workflow_run_id");
  if (workflowRunId.error)
    return {
      ok: false,
      response: validationErrorResponse([
        { path: ["workflow_run_id"], message: workflowRunId.error },
      ]),
    };
  const workload = readOptionalWorkloadField(raw, "workload");
  if (workload.error)
    return {
      ok: false,
      response: validationErrorResponse([{ path: ["workload"], message: workload.error }]),
    };
  return {
    ok: true,
    fields: {
      openPrOnReview: openPr.value,
      dispatchKind: dispatchKind.value,
      longLivedAgentId: longLivedAgentId.value,
      longLivedTickId: longLivedTickId.value,
      workflowRunId: workflowRunId.value,
      workload: workload.value,
    },
  };
}

function applyExtraFields(
  input: ChainStartRequestWithLongLived,
  fields: ChainStartExtraFields,
): Response | null {
  if (
    fields.workload !== undefined &&
    input.task_type !== undefined &&
    fields.workload !== input.task_type
  ) {
    return json(
      {
        error: {
          code: "validation_error",
          message: `chain_start: workload='${fields.workload}' conflicts with task_type='${input.task_type}'; pass only one or matching values`,
        },
      },
      400,
    );
  }
  const resolvedTaskType = fields.workload ?? input.task_type;
  if (resolvedTaskType !== undefined) input.task_type = resolvedTaskType;
  if (fields.openPrOnReview !== undefined) input.open_pr_on_review = fields.openPrOnReview;
  if (fields.dispatchKind !== undefined) input.dispatch_kind = fields.dispatchKind;
  if (fields.longLivedAgentId !== undefined) input.long_lived_agent_id = fields.longLivedAgentId;
  if (fields.longLivedTickId !== undefined) input.long_lived_tick_id = fields.longLivedTickId;
  if (fields.workflowRunId !== undefined) input.workflow_run_id = fields.workflowRunId;
  return null;
}

export async function chainStartFromInput(
  raw: unknown,
  services: Services,
  opts?: {
    applyMaestroBudgetGate?: boolean;
    requireActiveWorker?: boolean;
    // In-process workflow dispatch only (D8): the HTTP chain-start surface
    // must not let callers smuggle a cwd override into a dispatch.
    allowCwdOverride?: boolean;
  },
): Promise<Response> {
  const requireActiveWorker = opts?.requireActiveWorker ?? true;
  if (requireActiveWorker) {
    const workerGuard = workerHeartbeatGuard(services);
    if (workerGuard) return workerGuard;
  }

  const chainStartRequestSchemaWithoutDispatchKind = ChainStartRequestSchema.omit({
    dispatch_kind: true,
  });
  const parsed = chainStartRequestSchemaWithoutDispatchKind.safeParse(raw);
  if (!parsed.success) {
    return validationErrorResponse(
      parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
    );
  }
  if (opts?.allowCwdOverride !== true && parsed.data.cwd_override !== undefined) {
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

  const extras = parseChainStartExtraFields(raw);
  if (!extras.ok) return extras.response;
  const {
    openPrOnReview: openPrOnReviewValue,
    dispatchKind: dispatchKindValue,
    longLivedAgentId: longLivedAgentIdValue,
    longLivedTickId: longLivedTickIdValue,
    workflowRunId: workflowRunIdValue,
    workload: workloadValue,
  } = extras.fields;

  const normalizedInput = parsed.data as ChainStartRequestWithLongLived;

  const conflictResponse = applyExtraFields(normalizedInput, {
    openPrOnReview: openPrOnReviewValue,
    dispatchKind: dispatchKindValue,
    longLivedAgentId: longLivedAgentIdValue,
    longLivedTickId: longLivedTickIdValue,
    workflowRunId: workflowRunIdValue,
    workload: workloadValue,
  });
  if (conflictResponse) return conflictResponse;
  if (normalizedInput.task_class === undefined) {
    // F3c observability seam (counter-only, NO enforcement): task_class is
    // optional; its absence means no lane ever opens, which is the dominant
    // NULL gate_outcome cause. Count worktree-using legacy dispatches so the
    // miss is visible, but do NOT infer a default and do NOT reject — pure
    // instrumentation. use_worktree defaults to true upstream (~line 1188);
    // mirror that here so this counter tracks the same surface area.
    const useWorktreeEffective = normalizedInput.use_worktree !== false;
    if (useWorktreeEffective) incrementLegacyNoTaskClassUseWorktreeCounter();
    services.log.debug(
      {
        event: "dispatch.legacy_no_task_class",
        use_worktree: useWorktreeEffective,
        cumulative_use_worktree_misses: getLegacyNoTaskClassUseWorktreeCounter(),
      },
      "chain-start legacy dispatch without task_class",
    );
  }

  return await chainStartInternal(normalizedInput, services, {
    applyMaestroBudgetGate: opts?.applyMaestroBudgetGate ?? true,
  });
}

export async function chainsStartRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null)
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );
  return await chainStartFromInput(raw, services, {
    applyMaestroBudgetGate: true,
    requireActiveWorker: true,
  });
}

function enforceExplicitProjectIdGate(
  input: ChainStartRequestWithLongLived,
  services: Services,
): Response | null {
  const requireExplicitProjectId = isEnvTruthy(
    process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID,
  );
  if (!requireExplicitProjectId) return null;
  if (input.project_id !== undefined && input.project_id !== null) return null;
  if (canBypassExplicitProjectIdGate(input, services)) {
    services.log.info(
      {
        event: "chain_start.routing_guard.explicit_gate_exempted",
        dispatch_kind: input.dispatch_kind ?? null,
        long_lived_tick_id: input.long_lived_tick_id ?? null,
        workflow_run_id: input.workflow_run_id ?? null,
      },
      "chain-start explicit project_id gate exempted for internal hop",
    );
    return null;
  }
  return json(
    {
      error: "project_id_required",
      hint: "pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior",
    },
    400,
  );
}

interface ProjectRegistryGuardOutcome {
  response: Response | null;
  routingWarning: RoutingWarningPayload | undefined;
  routingAdvisory: RoutingAdvisoryPayload | undefined;
  projectRegistryEntries: { project_id: string; root_path: string }[] | undefined;
}

function maybeRejectMissingProjectIdForStrictWorkflow(
  input: ChainStartRequestWithLongLived,
  services: Services,
): Response | null {
  if (services.projectRegistry === undefined) return null;
  if (input.project_id !== null && input.project_id !== undefined) return null;
  if (input.dispatch_kind !== "workflow") return null;
  if (!input.workflow_run_id) return null;
  if (!isEnvTruthy(process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH)) return null;
  const info = services.workflowRuns?.verify(input.workflow_run_id) ?? null;
  services.log.warn(
    {
      event: "chain_start.routing_guard.workflow_exemption_rejected",
      project_id: input.project_id,
      info_project_id: info?.project_id ?? null,
      request_project_id: input.project_id,
      workflow_run_id_present: true,
    },
    "workflow dispatch_kind without project_id; strict routing guard remains in effect",
  );
  return json(
    {
      error: {
        code: "prompt_project_mismatch",
        project_id: input.project_id,
        mentioned_paths: [],
        missing_in_project: [],
        hint: "pass project_id explicitly or update prompt paths",
      },
    },
    400,
  );
}

function isInternalHopForMismatch(
  input: ChainStartRequestWithLongLived,
  services: Services,
): boolean {
  const longLivedExemptionResult = resolveLongLivedTickExemption(services, input);
  if (longLivedExemptionResult.ok) return true;
  if (input.dispatch_kind === "workflow") {
    const workflowExemptionResult = resolveWorkflowDispatchExemption(services, input);
    if (workflowExemptionResult.ok) return true;
    services.log.warn(
      {
        event: "chain_start.routing_guard.workflow_exemption_rejected",
        project_id: input.project_id,
        info_project_id:
          input.workflow_run_id && services.workflowRuns
            ? (services.workflowRuns.verify(input.workflow_run_id)?.project_id ?? null)
            : null,
        request_project_id: input.project_id,
        workflow_run_id_present: Boolean(input.workflow_run_id),
      },
      "workflow dispatch_kind without valid workflow_run_id; falling back to normal guard",
    );
  }
  const parentHandoff =
    typeof input.parent_handoff_id === "string"
      ? services.handoffReader.get(input.parent_handoff_id)
      : undefined;
  return (
    parentHandoff !== undefined &&
    parentHandoff !== null &&
    parentHandoff.project_id !== null &&
    parentHandoff.project_id === input.project_id
  );
}

async function runProjectRegistryGuard(
  input: ChainStartRequestWithLongLived,
  services: Services,
): Promise<ProjectRegistryGuardOutcome> {
  const strictReject = maybeRejectMissingProjectIdForStrictWorkflow(input, services);
  if (strictReject) {
    return {
      response: strictReject,
      routingWarning: undefined,
      routingAdvisory: undefined,
      projectRegistryEntries: undefined,
    };
  }
  if (
    services.projectRegistry === undefined ||
    input.project_id === null ||
    input.project_id === undefined
  ) {
    return {
      response: null,
      routingWarning: undefined,
      routingAdvisory: undefined,
      projectRegistryEntries: undefined,
    };
  }
  try {
    const projectRegistryEntries = services.projectRegistry.list();
    const guardResult = await inspectPromptVsProject({
      prompt: input.message,
      project_id: input.project_id,
      branch_base: input.branch_base,
      registry: projectRegistryEntries,
    });
    if (guardResult.status !== "mismatch") {
      return {
        response: null,
        routingWarning: undefined,
        routingAdvisory: undefined,
        projectRegistryEntries,
      };
    }
    const routingWarning: RoutingWarningPayload = {
      code: "prompt_project_mismatch",
      project_id: input.project_id,
      mentioned_paths: guardResult.mentioned_paths,
      missing_in_project: guardResult.missing_in_project,
      suggested_project_id: guardResult.suggested_project_id,
      hint: "pass project_id explicitly or update prompt paths",
    };
    const isInternalHop = isInternalHopForMismatch(input, services);
    services.log.warn(
      {
        event: isInternalHop
          ? "chain_start.routing_guard.internal_hop_mismatch"
          : "chain_start.routing_guard.mismatch",
        project_id: input.project_id,
        mentioned_paths: guardResult.mentioned_paths,
        missing_in_project: guardResult.missing_in_project,
        suggested_project_id: guardResult.suggested_project_id,
      },
      isInternalHop
        ? "chain-start internal hop prompt/project mismatch"
        : "chain-start prompt/project mismatch",
    );
    if (
      isEnvTruthy(process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH) &&
      !isInternalHop &&
      guardResult.suggested_project_id !== undefined
    ) {
      return {
        response: json({ error: routingWarning }, 400),
        routingWarning,
        routingAdvisory: undefined,
        projectRegistryEntries,
      };
    }
    return {
      response: null,
      routingWarning,
      routingAdvisory: undefined,
      projectRegistryEntries,
    };
  } catch (err) {
    services.log.warn(
      {
        event: "chain_start.routing_guard.registry_unavailable",
        project_id: input.project_id,
        error: err instanceof Error ? err.message : String(err),
      },
      "chain-start routing guard skipped because project registry was unavailable",
    );
    return {
      response: null,
      routingWarning: undefined,
      routingAdvisory: { code: "project_registry_unavailable" },
      projectRegistryEntries: undefined,
    };
  }
}

function stripAgentPrefixes(input: ChainStartRequestWithLongLived): {
  initialAgent: string;
  forceExactAgent: boolean;
  response: Response | null;
} {
  let initialAgent = input.initial_agent;
  if (initialAgent.startsWith("@")) {
    initialAgent = initialAgent.slice(1);
    input.initial_agent = initialAgent;
  }
  const forceExactAgent = initialAgent.startsWith("agent:");
  if (forceExactAgent) {
    initialAgent = initialAgent.slice("agent:".length);
    input.initial_agent = initialAgent;
  }
  if (initialAgent.length < 1) {
    return {
      initialAgent,
      forceExactAgent,
      response: json(
        {
          error: {
            code: "invalid_agent",
            agent: initialAgent,
            hint: "initial_agent must be non-empty after @-prefix/agent:-prefix stripping",
          },
        },
        400,
      ),
    };
  }
  return { initialAgent, forceExactAgent, response: null };
}

function rejectUnknownAgent(
  route: InitialRoute | null,
  input: ChainStartRequestWithLongLived,
  initialAgent: string,
  forceExactAgent: boolean,
  services: Services,
): Response | null {
  if (route) return null;
  if (!services.agentRegistry) return null;
  if (services.agentRegistry.includes(initialAgent)) return null;
  const nearest = getNearestAgents(initialAgent, services.agentRegistry);
  services.log.warn(
    {
      event: "chain_start.unknown_agent",
      initial_agent: initialAgent,
      force_exact_agent: forceExactAgent,
      task_type: input.task_type ?? null,
      parent_handoff_id: input.parent_handoff_id ?? null,
      registry_size: services.agentRegistry.length,
      nearest,
    },
    "chain-start unknown agent rejected",
  );
  return json(
    {
      error: {
        code: "unknown_agent",
        agent: initialAgent,
        did_you_mean: nearest,
        hint: "use chain.list_agents to enumerate valid agents",
      },
    },
    400,
  );
}

function applyClassifierDeclineFallback(
  input: ChainStartRequestWithLongLived,
  services: Services,
): { fallbackAgent: string | undefined; response: Response | null } {
  if (
    !input.parent_handoff_id ||
    !input.task_type ||
    !parentClassifierDeclined(services, input.parent_handoff_id)
  ) {
    return { fallbackAgent: undefined, response: null };
  }
  if (hasClassifierDeclinedAncestor(services, input.parent_handoff_id)) {
    return {
      fallbackAgent: undefined,
      response: json(
        {
          error: {
            code: "classifier_decline_retry_exhausted",
            parent_handoff_id: input.parent_handoff_id,
            message: "classifier-decline fallback already attempted",
          },
        },
        409,
      ),
    };
  }
  const cfg = services.agentchatConfig;
  const fallback = cfg ? maybeSelectClassifierDeclineFallback({ services, input, cfg }) : null;
  if (!fallback) {
    return {
      fallbackAgent: undefined,
      response: json(
        {
          error: {
            code: "classifier_decline_no_fallback",
            parent_handoff_id: input.parent_handoff_id,
            message: "classifier-declined dispatch has no fallback candidate",
          },
        },
        409,
      ),
    };
  }
  input.initial_agent = fallback;
  return { fallbackAgent: fallback, response: null };
}

function enforceMaestroBudgetForChainStart(
  input: ChainStartRequestWithLongLived,
  services: Services,
): Response | null {
  const maestroSessions =
    services.maestroSessions ??
    new MaestroSessionWriter({
      db: services.db,
      now: (): number => services.clock().getTime(),
    });
  const budgetGate = enforceMaestroBudget({
    db: services.db,
    sessions: maestroSessions,
    parent_handoff_id: input.parent_handoff_id ?? undefined,
  });
  if (!budgetGate.ok) return json(budgetGate.body, budgetGate.status);
  return null;
}

type PressureGateAgent = NonNullable<NonNullable<Services["agentchatConfig"]>["agents"]>[number];

function handlePressureGateOutcome(opts: {
  input: ChainStartRequestWithLongLived;
  services: Services;
  parentToAgent: string;
  cfg: NonNullable<Services["agentchatConfig"]>;
  gate: { subject: "maestro" | "sub_agent"; agent: PressureGateAgent; agent_name: string };
  outcome: ReturnType<typeof checkPressureCap>;
  providerCaps: Parameters<typeof checkPressureCap>[0]["providerCaps"];
}): { response?: Response; fallbackAgent?: string; continueLoop: boolean } {
  const { outcome } = opts;
  if (outcome.state === "warn") {
    console.warn("subscription pressure warning", {
      provider: outcome.provider,
      window_label: outcome.window_label,
      used_pct: outcome.used_pct,
      warn_pct: outcome.warn_pct,
      refuse_pct: outcome.refuse_pct,
    });
    return { continueLoop: true };
  }
  if (outcome.state !== "refuse") return { continueLoop: true };

  let fallbackRefusedOutcomes: CapCheckRefuse[] = [];
  let fallbackExhaustedReason:
    | "no_recommendations"
    | "no_candidates"
    | "all_refused"
    | "bias_excluded"
    | null = null;
  if (opts.gate.subject === "sub_agent") {
    const fallback = maybeSelectSubDispatchFallback({
      services: opts.services,
      input: opts.input,
      cfg: opts.cfg,
      providerCaps: opts.providerCaps,
      maestroAgentName: opts.parentToAgent,
      refusedOutcome: outcome,
    });
    fallbackRefusedOutcomes = fallback.refusedOutcomes;
    fallbackExhaustedReason = fallback.exhaustedReason;
    if (fallback.selectedAgent) {
      return { fallbackAgent: fallback.selectedAgent, continueLoop: true };
    }
  }

  const earliest_resets_at = earliestResetsAtForRefusals([outcome, ...fallbackRefusedOutcomes]);
  recordPressureCapTrip({
    services: opts.services,
    input: opts.input,
    subject: opts.gate.subject,
    agent_name: opts.gate.agent_name,
    maestro_agent_name: opts.parentToAgent,
    sub_agent_name: opts.input.initial_agent,
    outcome,
  });
  return {
    response: json(
      {
        error: {
          code: "subscription_pressure_capped",
          subject: opts.gate.subject,
          agent_name: opts.gate.agent_name,
          provider: outcome.provider,
          window_label: outcome.window_label,
          used_pct: outcome.used_pct,
          cap_pct: outcome.cap_pct,
          resets_at: outcome.resets_at,
          earliest_resets_at,
          ...(fallbackExhaustedReason === "bias_excluded"
            ? { exhausted_reason: fallbackExhaustedReason }
            : {}),
          snapshot_state: outcome.snapshot_state,
          snapshot_age_seconds: outcome.snapshot_age_seconds,
        },
      },
      400,
    ),
    continueLoop: false,
  };
}

function enforceSubscriptionPressureGate(
  input: ChainStartRequestWithLongLived,
  services: Services,
): { response?: Response; fallbackAgent?: string } {
  if (!input.parent_handoff_id) return {};
  const parentToAgent = services.handoffReader.get(input.parent_handoff_id)?.to_agent;
  if (!parentToAgent) return {};
  const cfg = services.agentchatConfig;
  const maestroAgent = cfg?.agents?.find((agent) => agent.name === parentToAgent);
  const subAgent = cfg?.agents?.find((agent) => agent.name === input.initial_agent);
  if (!cfg || !maestroAgent || !subAgent) return {};
  const providerCaps = buildProviderCaps(services.providerQuotas);
  const gateChecks = [
    { subject: "maestro" as const, agent: maestroAgent, agent_name: parentToAgent },
    { subject: "sub_agent" as const, agent: subAgent, agent_name: input.initial_agent },
  ];
  const syntheticCaps = collectSyntheticCaps(services);

  let fallbackAgent: string | undefined;
  for (const gate of gateChecks) {
    const outcome = checkPressureCap({
      cache: services.subscriptionPressureCache,
      agent: gate.agent,
      providerCaps,
      now: () => services.clock(),
      syntheticCaps,
      getRecentDispatchCount: makeGetRecentDispatchCount(services),
    });
    const result = handlePressureGateOutcome({
      input,
      services,
      parentToAgent,
      cfg,
      gate,
      outcome,
      providerCaps,
    });
    if (result.response) return { response: result.response };
    if (result.fallbackAgent !== undefined) fallbackAgent = result.fallbackAgent;
  }
  return fallbackAgent !== undefined ? { fallbackAgent } : {};
}

export function enforceRecursionDepthGuard(
  input: { parent_handoff_id?: string | null },
  services: Services,
): Response | null {
  if (!input.parent_handoff_id) return null;
  const cap = Number(process.env.PENUMBRA_RECURSION_DEPTH_CAP) || 8;
  const parentDepth = services.handoffReader.getSpawnDepth(input.parent_handoff_id);
  const newDepth = parentDepth + 1;
  if (newDepth < cap) return null;
  return json(
    {
      error: {
        code: "recursion_depth_exceeded",
        message: `chain.start spawn depth ${String(newDepth)} would meet/exceed cap ${String(cap)}`,
        depth: newDepth,
        cap,
      },
    },
    409,
  );
}

function guardUnknownProjectId(
  input: ChainStartRequestWithLongLived,
  services: Services,
  projectRegistryEntries: { project_id: string; root_path: string }[] | undefined,
): { response: Response | null; routingAdvisory: RoutingAdvisoryPayload | undefined } {
  if (
    input.project_id === null ||
    input.project_id === undefined ||
    projectRegistryEntries === undefined ||
    projectRegistryEntries.length === 0
  ) {
    return { response: null, routingAdvisory: undefined };
  }
  if (projectRegistryEntries.some((entry) => entry.project_id === input.project_id)) {
    return { response: null, routingAdvisory: undefined };
  }
  const projectId = input.project_id;
  const knownProjectIds = projectRegistryEntries.map((p) => p.project_id);
  if (!canBypassExplicitProjectIdGate(input, services)) {
    services.log.warn(
      {
        event: "chain_start.unknown_project_id_rejected",
        project_id: projectId,
        known_project_ids: knownProjectIds,
      },
      "chain-start unknown_project_id; rejecting",
    );
    return {
      response: json(
        {
          error: {
            code: "unknown_project",
            project_id: projectId,
            known_project_ids: knownProjectIds,
            hint: "pass a project_id present in the project registry",
          },
        },
        400,
      ),
      routingAdvisory: undefined,
    };
  }
  services.log.warn(
    {
      event: "chain_start.unknown_project_id_dropped",
      project_id: projectId,
      known_project_ids: knownProjectIds,
    },
    "chain-start unknown_project_id; dropping and continuing",
  );
  (input as { project_id?: string }).project_id = undefined;
  return {
    response: null,
    routingAdvisory: {
      code: "unknown_project_id_dropped",
      project_id: projectId,
      known_project_ids: knownProjectIds,
    },
  };
}

function resolveIsolatedInstall(
  input: ChainStartRequestWithLongLived,
  services: Services,
  taskClass: TaskClass | undefined,
): boolean | null {
  if (input.isolated_install !== undefined) {
    return input.isolated_install;
  }
  const parentHandoffForIsolation =
    typeof input.parent_handoff_id === "string"
      ? services.handoffReader.get(input.parent_handoff_id)
      : null;
  if (
    parentHandoffForIsolation?.isolated_install === true ||
    (parentHandoffForIsolation?.isolated_install as unknown) === 1
  ) {
    return true;
  }
  if (isEnvTruthy(process.env.PENUMBRA_ISOLATED_INSTALL_AUTO)) {
    return true;
  }
  if (
    taskClass === "BOUNDARY" &&
    isEnvTruthy(process.env.PENUMBRA_ISOLATED_INSTALL_AUTO_BOUNDARY)
  ) {
    return true;
  }
  return null;
}

function readAutoRecallEnabled(services: Services): boolean {
  const v = process.env.PENUMBRA_AUTO_RECALL_ENABLED;
  if (v === undefined) return true;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  services.log.warn(
    { event: "dispatch.auto_recall_env_invalid", value: v },
    `PENUMBRA_AUTO_RECALL_ENABLED='${v}' is not a recognized boolean; defaulting to enabled`,
  );
  return true;
}

interface AutoRecallOutcome {
  handoffMessage: string;
  recalled_memory_ids: string[];
  recalled_memories: { id: string; title: string; obs_type: string; snippet_head?: string }[];
  recalled_query: string | null;
}

function maybeLoadProjectBriefInjection(services: Services, projectId: string): string | null {
  if (!isEnvTruthy(process.env.PENUMBRA_AUTO_RECALL_PROJECT_BRIEF)) return null;
  const projectBrief = services.db
    .query<
      { brief_md: string },
      [string]
    >(`SELECT brief_md FROM project_briefs WHERE project_id=? ORDER BY generated_at DESC LIMIT 1`)
    .get(projectId);
  if (!projectBrief?.brief_md) return null;
  return renderProjectBriefInjectedText(projectBrief.brief_md);
}

async function maybeRunAutoRecall(
  input: ChainStartRequestWithLongLived,
  services: Services,
  taskClass: TaskClass | undefined,
  stampedMessage: string,
): Promise<AutoRecallOutcome> {
  const empty: AutoRecallOutcome = {
    handoffMessage: stampedMessage,
    recalled_memory_ids: [],
    recalled_memories: [],
    recalled_query: null,
  };
  if (taskClass === undefined) return empty;
  if (!input.project_id) {
    services.log.debug(
      { event: "dispatch.auto_recall_skipped_no_project_id", task_class: taskClass },
      "auto-recall skipped — no project_id on dispatch",
    );
    return empty;
  }
  if (!readAutoRecallEnabled(services)) return empty;

  const AUTO_RECALL_TIMEOUT_MS = 1500;
  const autoRecallController = new AbortController();
  const injectedSections: string[] = [];
  const projectBriefInjection = maybeLoadProjectBriefInjection(services, input.project_id);
  if (projectBriefInjection) injectedSections.push(projectBriefInjection);
  const autoPromise = autoRecallForDispatch(
    {
      prompt: input.message,
      task_class: taskClass,
      project_id: input.project_id,
      signal: autoRecallController.signal,
    },
    {
      memoryRecall: async (args) => {
        const recallReq = RecallRequestSchema.parse({
          query: args.query,
          limit: args.top_k,
          project_id: args.project_id ?? null,
        });
        const results: RecallResult[] = await services.recallReader.recall(recallReq, {
          signal: args.signal,
        });
        return {
          hits: results.map((r) => ({
            id: r.id,
            title: r.title ?? "",
            snippet: r.body,
            tier: r.tier,
          })),
        };
      },
      logger: (level, msg, meta): void => {
        services.log[level]({ ...meta, event: "dispatch.auto_recall" }, msg);
      },
    },
  );
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    const handle = setTimeout(() => {
      // Bound post-deadline recall work, not only the caller's wait.
      autoRecallController.abort();
      resolve(null);
    }, AUTO_RECALL_TIMEOUT_MS);
    handle.unref();
    timeoutHandle = handle;
  });
  let auto: Awaited<typeof autoPromise> | null;
  try {
    auto = await Promise.race([autoPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
  let recalled_memory_ids: string[] = [];
  let recalled_memories: AutoRecallOutcome["recalled_memories"] = [];
  let recalled_query: string | null = null;
  if (auto === null) {
    services.log.warn(
      { event: "dispatch.auto_recall_timeout", timeout_ms: AUTO_RECALL_TIMEOUT_MS },
      "auto-recall exceeded deadline — proceeding without injection",
    );
  } else {
    recalled_memory_ids = auto.recalled_memory_ids;
    recalled_memories = auto.recalled_memories;
    recalled_query = auto.recalled_query || null;
    if (auto.injected_text) injectedSections.push(auto.injected_text);
  }
  const handoffMessage =
    injectedSections.length > 0
      ? `${injectedSections.join("\n\n")}\n\n${stampedMessage}`
      : stampedMessage;
  return { handoffMessage, recalled_memory_ids, recalled_memories, recalled_query };
}

// Review and plan personas inspect the repository without a worktree and must
// never mutate it; when the caller didn't name a profile, no-worktree
// review/plan dispatches default to the read-only profile so routing and the
// seat gate below can fail closed instead of dispatching unconstrained.
const PROFILE_DEFAULTING_TASK_TYPES: ReadonlySet<AgentTaskType> = new Set([
  "review_adversarial",
  "plan_refine",
]);

function applyPermissionProfileDefault(input: ChainStartRequestWithLongLived): void {
  if (
    input.permission_profile !== undefined ||
    input.use_worktree !== false ||
    input.task_type === undefined ||
    !PROFILE_DEFAULTING_TASK_TYPES.has(input.task_type)
  )
    return;
  input.permission_profile = PERMISSION_PROFILE_REVIEW_READONLY;
}

// A chain-start issued inside an existing chain is a hop, not a fresh root:
// it inherits the parent's permission profile and caller_cwd so a profiled
// persona cannot spawn an unprofiled child that mutates on its behalf. A hop
// under a scratch-bound parent is rejected outright: scratch dispatches pin
// max_hops:1, and a child row would carry a scratch root bound to a run id
// the child does not own — there is no legitimate hop here.
function applyParentProfileInheritance(
  input: ChainStartRequestWithLongLived,
  services: Services,
): Response | null {
  if (typeof input.parent_handoff_id !== "string") return null;
  const parent = services.handoffReader.get(input.parent_handoff_id);
  if (!parent) return null;
  if (parent.cwd_override !== null && parent.cwd_override !== undefined) {
    return json(
      {
        error: {
          code: "cwd_override_parent_scratch",
          message:
            "child handoffs are not allowed under a scratch-bound parent; scratch dispatches pin max_hops:1",
          parent_cwd_override: parent.cwd_override,
        },
      },
      400,
    );
  }
  input.permission_profile ??= parent.permission_profile ?? undefined;
  input.caller_cwd ??= parent.caller_cwd ?? undefined;
  return null;
}

function rejectUnsupportedPermissionProfile(
  input: ChainStartRequestWithLongLived,
): Response | null {
  const profile = input.permission_profile;
  if (profile === undefined || (PERMISSION_PROFILES as readonly string[]).includes(profile))
    return null;
  return json(
    {
      error: {
        code: "unsupported_permission_profile",
        message: `permission_profile '${profile}' is not supported by this daemon`,
      },
    },
    422,
  );
}

function seatEnforcesInputProfile(
  cfg: AgentChatConfigLike,
  input: ChainStartRequestWithLongLived,
  agentName: string,
): boolean {
  const profile = input.permission_profile;
  if (profile === undefined) return true;
  const seat = cfg.agents?.find((candidate) => candidate.name === agentName);
  return agentEnforcesPermissionProfile(seat, profile);
}

function enforcePermissionProfileSeatGate(
  services: Services,
  routedAgent: string,
  profile: PermissionProfile | undefined,
): Response | null {
  if (profile === undefined) return null;
  const agents = (services.agentchatConfig as AgentChatConfigLike | undefined)?.agents;
  const seat = agents?.find((candidate) => candidate.name === routedAgent);
  if (agentEnforcesPermissionProfile(seat, profile)) return null;
  services.log.warn(
    {
      event: "chain_start.permission_profile_unenforceable",
      agent: routedAgent,
      permission_profile: profile,
    },
    "chain-start profiled dispatch rejected: seat cannot enforce the profile",
  );
  return json(
    {
      error: {
        code: "permission_profile_unenforceable",
        message: `agent '${routedAgent}' cannot enforce permission_profile '${profile}'`,
        agent: routedAgent,
        permission_profile: profile,
      },
    },
    422,
  );
}

interface PersistChainStartArgs {
  services: Services;
  input: ChainStartRequestWithLongLived;
  user_prompt_event_id: string;
  handoff_id: string;
  ts: string;
  conversation_id: string;
  routedAgent: string;
  routedRole: string | null;
  requestedAgent: string | null;
  routingResolutionReason: string | null;
  handoffMessage: string;
  route: InitialRoute | null;
  isolatedInstall: boolean | null;
  openPrOnReviewBool: boolean | undefined;
  lane_id: string | null;
  taskClass: TaskClass | undefined;
  recalled_memory_ids: string[];
  recalled_query: string | null;
  branchName: string | null;
}

function persistChainStart(args: PersistChainStartArgs): void {
  const {
    services,
    input,
    user_prompt_event_id,
    handoff_id,
    ts,
    conversation_id,
    routedAgent,
    routedRole,
    requestedAgent,
    routingResolutionReason,
    handoffMessage,
    route,
    isolatedInstall,
    openPrOnReviewBool,
    lane_id,
    taskClass,
    recalled_memory_ids,
    recalled_query,
    branchName,
  } = args;
  services.db.transaction(() => {
    services.t0Writer.write({
      event_id: user_prompt_event_id,
      ts,
      ingest_ts: ts,
      source: "agentchat",
      source_detail: "chain-start",
      project_id: input.project_id ?? null,
      user_id: "local-user",
      machine_id: services.machineId.get(),
      session_id: conversation_id,
      event_type: "user-prompt",
      lane: "cli-subscription",
      provider: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      latency_ms: null,
      request_id: null,
      payload_json: { prompt: input.message },
      payload_summary: input.message.slice(0, 240),
      origin: null,
    });
    services.handoffWriter.createApproved({
      handoff_id,
      ts,
      project_id: input.project_id ?? null,
      conversation_id,
      from: "user",
      to: routedAgent,
      to_role: routedRole,
      requested_agent: requestedAgent,
      routing_resolution_reason: routingResolutionReason,
      message: handoffMessage,
      triggered_by_event_id: user_prompt_event_id,
      resolved_by: "chain-start",
      resolved_at: null,
      chain_max_hops: input.max_hops ?? null,
      chain_trust_mode: input.trust_mode ?? null,
      chain_task_type: route?.taskType ?? input.task_type ?? null,
      dispatch_kind: input.dispatch_kind ?? null,
      // The claim-spread fairness cap and every workflow-to-cost join key on this column.
      workflow_run_id: input.workflow_run_id ?? null,
      long_lived_agent_id: input.long_lived_agent_id ?? null,
      long_lived_tick_id: input.long_lived_tick_id ?? null,
      use_worktree: input.use_worktree ?? true,
      isolated_install: isolatedInstall,
      parent_handoff_id: input.parent_handoff_id ?? null,
      branch_base: input.branch_base ?? null,
      branch_name: branchName,
      permission_profile: input.permission_profile ?? null,
      caller_cwd: input.caller_cwd ?? null,
      cwd_override: input.cwd_override ?? null,
    });
    if (openPrOnReviewBool !== undefined) {
      services.db
        .query<
          unknown,
          [number, string]
        >(`UPDATE handoffs SET open_pr_on_review=? WHERE handoff_id=?`)
        .run(openPrOnReviewBool ? 1 : 0, handoff_id);
    }
    if (lane_id !== null && taskClass !== undefined) {
      // TRIVIAL workflow-internal dispatches (persona/synthesizer fan-out)
      // produce nothing to land and run no gate — the orphan-lane sweeper
      // would close them 'skipped' anyway — so their lane is recorded
      // already closed instead of leaking to the sweeper. Non-TRIVIAL
      // no-worktree dispatches stay open so the sweeper can record
      // review_debt.
      const trivialWorkflowInternal =
        input.dispatch_kind === "workflow" &&
        input.use_worktree === false &&
        taskClass === "TRIVIAL";
      insertLane(services.db, {
        lane_id,
        ts_opened: ts,
        ...(trivialWorkflowInternal
          ? {
              ts_closed: ts,
              gate_status: "skipped" as const,
              override_reason:
                "TRIVIAL workflow-internal dispatch with no worktree: nothing to land, no gate",
            }
          : {}),
        task_class: taskClass,
        implementer_handoff: handoff_id,
        recalled_memory_ids,
        recalled_query,
      });
    }
  })();
}

interface BuildChainStartResponseArgs {
  services: Services;
  conversation_id: string;
  handoff_id: string;
  branchName: string | null;
  taskClass: TaskClass | undefined;
  lane_id: string | null;
  recalled_memory_ids: string[];
  recalled_memories: { id: string; title: string; obs_type: string; snippet_head?: string }[];
  routedAgent: string;
  routedRole: string | null;
  requestedAgent: string | null;
  routingResolutionReason: string | null;
  route: InitialRoute | null;
  routingWarning: RoutingWarningPayload | undefined;
  routingAdvisory: RoutingAdvisoryPayload | undefined;
  permissionProfile: PermissionProfile | undefined;
}

function buildChainStartResponse(args: BuildChainStartResponseArgs): Response {
  const body = {
    conversation_id: args.conversation_id,
    handoff_id: args.handoff_id,
    branch_name: args.branchName,
    ...(args.permissionProfile !== undefined ? { permission_profile: args.permissionProfile } : {}),
    ...(args.taskClass !== undefined
      ? {
          task_class: args.taskClass,
          lane_id: args.lane_id,
          recalled_memory_ids: args.recalled_memory_ids,
          recalled_memories: args.recalled_memories,
        }
      : {}),
    ...(args.routedRole
      ? {
          routed_agent: args.routedAgent,
          routed_role: args.routedRole,
          routing_task_type: args.route?.taskType,
        }
      : {}),
    ...(args.requestedAgent !== null && args.routingResolutionReason !== null
      ? {
          requested_agent: args.requestedAgent,
          resolved_agent: args.routedAgent,
          routing_resolution_reason: args.routingResolutionReason,
        }
      : {}),
    ...(args.routingWarning !== undefined ? { routing_warning: args.routingWarning } : {}),
    ...(args.routingAdvisory !== undefined ? { routing_advisory: args.routingAdvisory } : {}),
  };
  const parsed = ChainStartResponseSchema.safeParse(body);
  if (parsed.success) return json(parsed.data);
  args.services.log.error(
    {
      event: "chain_start.response_schema_parse_failed",
      handoff_id: args.handoff_id,
      conversation_id: args.conversation_id,
      error: parsed.error.message,
    },
    "chain-start response schema parse failed; failing closed",
  );
  return json(
    {
      error: {
        code: "response_contract_violation",
        message: "chain-start built a response that violates ChainStartResponseSchema",
        handoff_id: args.handoff_id,
        conversation_id: args.conversation_id,
      },
    },
    500,
  );
}

interface RoutingResolution {
  response: Response | null;
  route: InitialRoute | null;
  routedAgent: string;
  routedRole: string | null;
  requestedAgent: string | null;
  routingResolutionReason: string | null;
  routingDecision: RoutingDecision | null;
}

function rerouteForAgent(
  services: Services,
  initialAgent: string,
): { route: InitialRoute | null; routedAgent: string; routedRole: string | null } {
  const route = services.agentRegistry?.includes(initialAgent)
    ? { agent: initialAgent, role: null, taskType: null }
    : null;
  return {
    route,
    routedAgent: route?.agent ?? initialAgent,
    routedRole: route === null ? null : route.role,
  };
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve routing fallback resolution while grandfathering its pre-existing complexity.
function resolveRoutingWithFallbacks(
  input: ChainStartRequestWithLongLived,
  services: Services,
  applyMaestroBudgetGate: boolean,
): RoutingResolution {
  const stripped = stripAgentPrefixes(input);
  if (stripped.response) {
    return {
      response: stripped.response,
      route: null,
      routedAgent: "",
      routedRole: null,
      requestedAgent: null,
      routingResolutionReason: null,
      routingDecision: null,
    };
  }
  let { initialAgent } = stripped;
  const { forceExactAgent } = stripped;
  const requestedAgent = initialAgent;
  let routingResolutionReason: string | null = null;

  const {
    route: initialRoute,
    decision: routingDecision,
    roleRouteAttempted,
  } = resolveInitialRoute({
    initialAgent,
    message: input.message,
    taskType: input.task_type,
    forceExactAgent,
    services,
    harness: {
      taskClass: input.task_class,
      projectId: input.project_id ?? undefined,
      dispatchKind: input.dispatch_kind,
      tool_free: input.tool_free,
      permission_profile: input.permission_profile,
    },
  });
  let route = initialRoute;

  if (!route && roleRouteAttempted) {
    return {
      response: json(
        {
          error: {
            code: "role_route_unavailable",
            message: "the model task router returned no route for the requested role",
            role: initialAgent,
          },
        },
        422,
      ),
      route: null,
      routedAgent: "",
      routedRole: null,
      requestedAgent: null,
      routingResolutionReason: null,
      routingDecision,
    };
  }

  const unknownAgentResponse = rejectUnknownAgent(
    route,
    input,
    initialAgent,
    forceExactAgent,
    services,
  );
  if (unknownAgentResponse) {
    return {
      response: unknownAgentResponse,
      route: null,
      routedAgent: "",
      routedRole: null,
      requestedAgent: null,
      routingResolutionReason: null,
      routingDecision: null,
    };
  }

  let routedAgent = route?.agent ?? initialAgent;
  let routedRole = route?.role ?? null;
  if (routedAgent !== requestedAgent && routedRole !== null) {
    routingResolutionReason = "role_route";
  }

  const classifierFallback = applyClassifierDeclineFallback(input, services);
  if (classifierFallback.response) {
    return {
      response: classifierFallback.response,
      route: null,
      routedAgent: "",
      routedRole: null,
      requestedAgent: null,
      routingResolutionReason: null,
      routingDecision: null,
    };
  }
  if (classifierFallback.fallbackAgent !== undefined) {
    initialAgent = classifierFallback.fallbackAgent;
    ({ route, routedAgent, routedRole } = rerouteForAgent(services, initialAgent));
    if (routedAgent !== requestedAgent) {
      routingResolutionReason = "classifier_decline_fallback";
    }
  }

  if (applyMaestroBudgetGate) {
    const budgetResponse = enforceMaestroBudgetForChainStart(input, services);
    if (budgetResponse) {
      return {
        response: budgetResponse,
        route: null,
        routedAgent: "",
        routedRole: null,
        requestedAgent: null,
        routingResolutionReason: null,
        routingDecision: null,
      };
    }
  }

  const pressureOutcome = enforceSubscriptionPressureGate(input, services);
  if (pressureOutcome.response) {
    return {
      response: pressureOutcome.response,
      route: null,
      routedAgent: "",
      routedRole: null,
      requestedAgent: null,
      routingResolutionReason: null,
      routingDecision: null,
    };
  }
  if (pressureOutcome.fallbackAgent !== undefined) {
    initialAgent = pressureOutcome.fallbackAgent;
    ({ route, routedAgent, routedRole } = rerouteForAgent(services, initialAgent));
    if (routedAgent !== requestedAgent) {
      routingResolutionReason = "subscription_pressure_fallback";
    }
  }

  return {
    response: null,
    route,
    routedAgent,
    routedRole,
    requestedAgent: routingResolutionReason === null ? null : requestedAgent,
    routingResolutionReason,
    routingDecision,
  };
}

function projectRootForBranchPrecheck(
  input: ChainStartRequestWithLongLived,
  services: Services,
  projectRegistryEntries: { project_id: string; root_path: string }[] | undefined,
): string | undefined {
  if (input.project_id) {
    const registryRoot = projectRegistryEntries?.find(
      (entry) => entry.project_id === input.project_id,
    )?.root_path;
    return registryRoot ?? services.worktreeManager.projectRootFor(input.project_id);
  }
  return services.worktreeManager.mainRepoDir;
}

function persistRoutingDecisionForChainStart(
  services: Services,
  decision: RoutingDecision,
  opts: {
    ts: string;
    handoffId: string | null;
    routedAgent?: string;
    role?: string;
  },
): void {
  const routerMode = services.taskRouterConfig?.mode ?? "off";
  writeRoutingDecision(services.db, decision, {
    decisionId: services.uuid(),
    ts: opts.ts,
    handoffId: opts.handoffId,
    mode: routerMode,
    applied:
      opts.handoffId !== null &&
      routerMode === "auto" &&
      decision.selected?.agent === opts.routedAgent,
    role: opts.role,
  });
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve chain-start orchestration while grandfathering its pre-existing complexity.
export async function chainStartInternal(
  input: ChainStartRequestWithLongLived,
  services: Services,
  opts?: { applyMaestroBudgetGate?: boolean },
): Promise<Response> {
  const applyMaestroBudgetGate = opts?.applyMaestroBudgetGate ?? false;
  applyPermissionProfileDefault(input);
  const parentInheritanceResponse = applyParentProfileInheritance(input, services);
  if (parentInheritanceResponse) return parentInheritanceResponse;
  const unsupportedProfileResponse = rejectUnsupportedPermissionProfile(input);
  if (unsupportedProfileResponse) return unsupportedProfileResponse;

  const explicitProjectIdResponse = enforceExplicitProjectIdGate(input, services);
  if (explicitProjectIdResponse) return explicitProjectIdResponse;

  const guardOutcome = await runProjectRegistryGuard(input, services);
  if (guardOutcome.response) return guardOutcome.response;
  const { routingWarning, projectRegistryEntries } = guardOutcome;
  let routingAdvisory = guardOutcome.routingAdvisory;

  let routing: RoutingResolution;
  try {
    routing = resolveRoutingWithFallbacks(input, services, applyMaestroBudgetGate);
  } catch (err) {
    if (err instanceof RouterHardConstraintExhaustedError) {
      persistRoutingDecisionForChainStart(services, err.decision, {
        ts: services.clock().toISOString(),
        handoffId: null,
        role: input.initial_agent,
      });
      return json(
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
      );
    }
    if (err instanceof RoutingBiasExhaustedError) {
      return json(
        {
          error: {
            code: "routing_bias_exhausted",
            message: "routing biases excluded every candidate for the requested role",
            role: err.role,
            task_type: err.taskType,
          },
        },
        422,
      );
    }
    throw err;
  }
  if (routing.response) {
    if (routing.routingDecision) {
      persistRoutingDecisionForChainStart(services, routing.routingDecision, {
        ts: services.clock().toISOString(),
        handoffId: null,
        role: input.initial_agent,
      });
    }
    return routing.response;
  }
  const {
    route,
    routedAgent,
    routedRole,
    requestedAgent,
    routingResolutionReason,
    routingDecision,
  } = routing;

  const profileSeatResponse = enforcePermissionProfileSeatGate(
    services,
    routedAgent,
    input.permission_profile,
  );
  if (profileSeatResponse) return profileSeatResponse;

  // A profiled dispatch also requires at least one live worker that declared
  // enforcement at registration — otherwise the approved handoff is
  // unclaimable-by-design and starves in the queue instead of failing here.
  if (input.permission_profile !== undefined) {
    const profileWorkerResponse = profiledLiveWorkerGateResponse(
      services,
      input.permission_profile,
      input.project_id ?? null,
    );
    if (profileWorkerResponse) return profileWorkerResponse;
  }

  const depthResponse = enforceRecursionDepthGuard(input, services);
  if (depthResponse) return depthResponse;

  const unknownProjectId = guardUnknownProjectId(input, services, projectRegistryEntries);
  if (unknownProjectId.response) return unknownProjectId.response;
  routingAdvisory = unknownProjectId.routingAdvisory ?? routingAdvisory;

  // cwd_override binding (P6): only workflow-dispatched, no-worktree starts
  // may carry one, and the path must be the daemon-owned scratch of this
  // workflow_run_id under the resolved project's fleet base. Validated after
  // guardUnknownProjectId because that gate may drop/normalize project_id.
  if (input.cwd_override !== undefined) {
    if (
      input.use_worktree !== false ||
      input.dispatch_kind !== "workflow" ||
      typeof input.workflow_run_id !== "string" ||
      input.workflow_run_id.length === 0
    ) {
      return json(
        {
          error: {
            code: "cwd_override_requires_workflow_dispatch",
            message:
              "cwd_override requires dispatch_kind 'workflow', use_worktree false, and a workflow_run_id",
          },
        },
        400,
      );
    }
    // The override's git lineage is authoritative for the project when the
    // request carries none — for example a synthetic caller-side id that the
    // unknown-project gate dropped. Derive it from the scratch's common dir
    // so a second registered project's scratch still validates; a repo the
    // daemon does not know fails closed.
    if (input.project_id === undefined || input.project_id === null) {
      const derived = services.scratchWorktrees.scratchCwdProject(input.cwd_override);
      if (derived.status === "unmatched") {
        return json(
          {
            error: {
              code: "scratch_cwd_unknown_project",
              message:
                "cwd_override scratch does not share a git common dir with the daemon's main repo or any registered project",
            },
          },
          400,
        );
      }
      if (
        derived.status === "matched" &&
        derived.project_id !== null &&
        derived.project_id !== undefined
      ) {
        input.project_id = derived.project_id;
      }
    }
    const scratchValidation = services.scratchWorktrees.validateCwdOverride({
      cwd_override: input.cwd_override,
      owner_run_id: input.workflow_run_id,
      project_id: input.project_id ?? null,
    });
    if (!scratchValidation.ok) {
      return json(
        {
          error: {
            code: "invalid_scratch_cwd_override",
            message: `cwd_override is not a valid daemon-owned scratch root for this run: ${scratchValidation.reason}`,
            reason: scratchValidation.reason,
          },
        },
        400,
      );
    }
    // Persist the canonical realpath — the worker re-validates the stored
    // string against the on-disk owner marker, so a symlinked spelling of the
    // same dir must normalize to the same value here.
    input.cwd_override = scratchValidation.path;
    const scratchWorkerResponse = scratchLiveWorkerGateResponse(services, input.project_id ?? null);
    if (scratchWorkerResponse) return scratchWorkerResponse;
  }

  const conversation_id = input.conversation_id ?? `conv-${services.uuid()}`;
  const user_prompt_event_id = services.uuid();
  const handoff_id = services.uuid();
  const ts = services.clock().toISOString();
  const openPrOnReview = (input as { open_pr_on_review?: unknown }).open_pr_on_review;
  const openPrOnReviewBool = typeof openPrOnReview === "boolean" ? openPrOnReview : undefined;
  const taskClass = (input as { task_class?: TaskClass }).task_class;
  const isolatedInstall = resolveIsolatedInstall(input, services, taskClass);
  const branchName = await (async (): Promise<string | null> => {
    if (input.use_worktree === false) return null;
    // input.message is the raw, pre-stamp/pre-recall message (stamped/handoffMessage
    // are computed later, below) — naming off those would bake stamped retry
    // metadata or injected recall context into the branch name.
    const requestedName = buildHandoffBranchName({
      handoff_id,
      task_name: input.task_name,
      branch_type: input.branch_type,
      workload: route?.taskType ?? input.task_type ?? undefined,
      message: input.message,
    });
    if (!slugifyBranchSegment(input.task_name ?? "")) {
      services.log.info(
        {
          event: "dispatch.branch_name_derived",
          handoff_id,
          derived_slug: deriveBranchNameFromMessage(input.message) || null,
          branch_name: requestedName,
        },
        "chain-start derived branch name from dispatch message",
      );
    }
    return await availableBranchNameBestEffort(
      projectRootForBranchPrecheck(input, services, projectRegistryEntries),
      requestedName,
    );
  })();
  if (taskClass !== undefined) {
    services.log.debug(
      { event: "dispatch.task_class", task_class: taskClass },
      "chain-start dispatch task_class",
    );
  }
  const stamped = buildStampedLongLivedPrompt(input, services);
  if (stamped.errorResponse) return stamped.errorResponse;

  const lane_id: string | null = taskClass !== undefined ? `lane-${services.uuid()}` : null;
  const autoRecall = await maybeRunAutoRecall(input, services, taskClass, stamped.message);
  const handoffMessage = autoRecall.handoffMessage;
  const { recalled_memory_ids, recalled_memories, recalled_query } = autoRecall;

  persistChainStart({
    services,
    input,
    user_prompt_event_id,
    handoff_id,
    ts,
    conversation_id,
    routedAgent,
    routedRole,
    requestedAgent,
    routingResolutionReason,
    handoffMessage,
    route,
    isolatedInstall,
    openPrOnReviewBool,
    lane_id,
    taskClass,
    recalled_memory_ids,
    recalled_query,
    branchName,
  });

  if (routingDecision) {
    persistRoutingDecisionForChainStart(services, routingDecision, {
      ts,
      handoffId: handoff_id,
      routedAgent,
      role: requestedAgent ?? routedRole ?? undefined,
    });
  }

  return buildChainStartResponse({
    services,
    conversation_id,
    handoff_id,
    branchName,
    taskClass,
    lane_id,
    recalled_memory_ids,
    recalled_memories,
    routedAgent,
    routedRole,
    requestedAgent,
    routingResolutionReason,
    route,
    routingWarning,
    routingAdvisory,
    permissionProfile: input.permission_profile,
  });
}

// NAMED SEAM: routeAgent(detail:"summary") (buildRecommendations in
// agent-routing.ts) does not read RouteAgentInput.activeBiases at all today —
// only detail:"rank"/"single" do. Forwarding activeBiases into the
// routeAgent() calls below is therefore necessary-but-not-sufficient; this
// post-filter is what closes the bypass for the summary path. If
// buildRecommendations ever grows native bias support, delete this local
// application point rather than applying routing biases twice.
function applyRoutingBiasesToRecommendations(
  recommendations: AgentRecommendation[],
  cfg: AgentChatConfigLike,
  biases: RoutingBias[] | undefined,
): AgentRecommendation[] {
  if (!biases || biases.length === 0) return recommendations;
  const scored = recommendations.map((recommendation) => ({
    recommendation,
    effect: resolveBiasEffect(
      recommendation.agent_name,
      resolveProvider(
        cfg.agents?.find((candidate) => candidate.name === recommendation.agent_name) ?? {},
      ),
      biases,
    ),
  }));
  const kept = scored.filter((s) => !s.effect.exclude);
  return kept
    .map((s) => ({
      ...s,
      // Summary recommendations expose success_rate, not buildRank's composite
      // score. Closing this arithmetic divergence requires carrying the
      // composite score (or its inputs) on AgentRecommendation.
      biasedScore: s.recommendation.success_rate * s.effect.factor,
    }))
    .sort((a, b) => b.biasedScore - a.biasedScore)
    .map((s) => s.recommendation);
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve sub-dispatch fallback selection while grandfathering its pre-existing complexity.
function maybeSelectSubDispatchFallback(opts: {
  services: Services;
  input: ChainStartRequestWithLongLived;
  cfg: AgentChatConfigLike;
  providerCaps: Parameters<typeof checkPressureCap>[0]["providerCaps"];
  maestroAgentName: string;
  refusedOutcome: CapCheckRefuse;
}): {
  selectedAgent: string | null;
  refusedOutcomes: CapCheckRefuse[];
  exhaustedReason: "no_recommendations" | "no_candidates" | "all_refused" | "bias_excluded" | null;
} {
  if (!opts.input.parent_handoff_id)
    return { selectedAgent: null, refusedOutcomes: [], exhaustedReason: null };
  if (!opts.input.task_type)
    return { selectedAgent: null, refusedOutcomes: [], exhaustedReason: null };

  const refusedOutcomes: CapCheckRefuse[] = [];

  // Same steering data resolveSingleRoute reads for the primary route — see
  // readActiveRoutingBiases. Degrades to undefined on any read error.
  const activeBiases = readActiveRoutingBiases(opts.services);
  const route = routeAgent({
    db: opts.services.db,
    detail: "summary",
    taskType: opts.input.task_type,
    windowDays: 7,
    now: opts.services.clock(),
    activeBiases,
  });
  if (route.detail !== "summary")
    throw new Error("unexpected routeAgent detail for fallback recommendations");
  const rawRecommendations = route.recommendations;
  const recommendations: AgentRecommendation[] = applyRoutingBiasesToRecommendations(
    rawRecommendations,
    opts.cfg,
    activeBiases,
  );

  if (recommendations.length === 0) {
    const exhaustedReason = rawRecommendations.length > 0 ? "bias_excluded" : "no_recommendations";
    recordPressureFallbackEvent({
      services: opts.services,
      input: opts.input,
      maestroAgentName: opts.maestroAgentName,
      originalAgentName: opts.input.initial_agent,
      candidateAgent: null,
      candidateState: "exhausted",
      candidateOutcome: opts.refusedOutcome,
      attemptIndex: 0,
      totalAttempts: 0,
      ranking: null,
      exhaustedReason,
    });
    return { selectedAgent: null, refusedOutcomes, exhaustedReason };
  }

  const configAgents = new Set((opts.cfg.agents ?? []).map((agent) => agent.name));
  const rankedCandidates = recommendations
    .filter((recommendation) => recommendation.agent_name !== opts.input.initial_agent)
    .filter((recommendation) => configAgents.has(recommendation.agent_name))
    .filter((recommendation) =>
      seatEnforcesInputProfile(opts.cfg, opts.input, recommendation.agent_name),
    );

  const syntheticCaps = collectSyntheticCaps(opts.services);

  let attemptCount = 0;
  for (const recommendation of rankedCandidates) {
    if (attemptCount >= MAX_SUB_DISPATCH_FALLBACKS) break;

    const candidate = opts.cfg.agents?.find((agent) => agent.name === recommendation.agent_name);
    if (!candidate) continue;
    const outcome = checkPressureCap({
      cache: opts.services.subscriptionPressureCache,
      agent: candidate,
      providerCaps: opts.providerCaps,
      now: () => opts.services.clock(),
      syntheticCaps,
      getRecentDispatchCount: makeGetRecentDispatchCount(opts.services),
    });

    if (outcome.state === "refuse") {
      refusedOutcomes.push(outcome);
      recordPressureFallbackEvent({
        services: opts.services,
        input: opts.input,
        maestroAgentName: opts.maestroAgentName,
        originalAgentName: opts.input.initial_agent,
        candidateAgent: candidate.name,
        candidateState: "refuse",
        candidateOutcome: outcome,
        attemptIndex: attemptCount,
        totalAttempts: null,
        ranking: recommendation,
      });
      attemptCount += 1;
      continue;
    }

    recordPressureFallbackEvent({
      services: opts.services,
      input: opts.input,
      maestroAgentName: opts.maestroAgentName,
      originalAgentName: opts.input.initial_agent,
      candidateAgent: candidate.name,
      candidateState: "selected",
      candidateOutcome: outcome,
      attemptIndex: attemptCount,
      totalAttempts: null,
      ranking: recommendation,
    });
    attemptCount += 1;

    recordPressureFallbackEvent({
      services: opts.services,
      input: opts.input,
      maestroAgentName: opts.maestroAgentName,
      originalAgentName: opts.input.initial_agent,
      candidateAgent: candidate.name,
      candidateState: "selected",
      candidateOutcome: outcome,
      attemptIndex: attemptCount,
      totalAttempts: attemptCount,
      ranking: recommendation,
      exhaustedReason: null,
    });
    return { selectedAgent: candidate.name, refusedOutcomes, exhaustedReason: null };
  }

  const exhaustedReason = attemptCount === 0 ? "no_candidates" : "all_refused";
  recordPressureFallbackEvent({
    services: opts.services,
    input: opts.input,
    maestroAgentName: opts.maestroAgentName,
    originalAgentName: opts.input.initial_agent,
    candidateAgent: null,
    candidateState: "exhausted",
    candidateOutcome: opts.refusedOutcome,
    attemptIndex: attemptCount,
    totalAttempts: attemptCount,
    ranking: null,
    exhaustedReason,
  });
  return { selectedAgent: null, refusedOutcomes, exhaustedReason };
}

function parseDispatchEndMetaForHandoff(
  services: Services,
  handoffId: string,
): Record<string, unknown> | null {
  const row = services.db
    .query<{ meta_json: string | null }, [string]>(
      `SELECT meta_json
         FROM dispatch_events
        WHERE handoff_id = ? AND kind = 'dispatch.end'
        ORDER BY ts DESC, id DESC
        LIMIT 1`,
    )
    .get(handoffId);
  if (!row?.meta_json) return null;
  try {
    return JSON.parse(row.meta_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parentClassifierDeclined(services: Services, handoffId: string): boolean {
  return parseDispatchEndMetaForHandoff(services, handoffId)?.classifier_declined === true;
}

function hasClassifierDeclinedAncestor(services: Services, handoffId: string): boolean {
  const stmt = services.db.query<{ parent_handoff_id: string | null }, [string]>(
    `SELECT parent_handoff_id FROM handoffs WHERE handoff_id = ?`,
  );
  let cursor = stmt.get(handoffId)?.parent_handoff_id ?? null;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    if (parentClassifierDeclined(services, cursor)) return true;
    cursor = stmt.get(cursor)?.parent_handoff_id ?? null;
  }
  return false;
}

function maybeSelectClassifierDeclineFallback(opts: {
  services: Services;
  input: ChainStartRequestWithLongLived;
  cfg: AgentChatConfigLike;
}): string | null {
  if (!opts.input.task_type) return null;
  // Same steering data resolveSingleRoute reads for the primary route — see
  // readActiveRoutingBiases. Degrades to undefined on any read error.
  const activeBiases = readActiveRoutingBiases(opts.services);
  const route = routeAgent({
    db: opts.services.db,
    detail: "summary",
    taskType: opts.input.task_type,
    windowDays: 7,
    now: opts.services.clock(),
    activeBiases,
  });
  if (route.detail !== "summary")
    throw new Error("unexpected routeAgent detail for classifier fallback recommendations");

  const configAgents = new Set((opts.cfg.agents ?? []).map((agent) => agent.name));
  const recommendations = applyRoutingBiasesToRecommendations(
    route.recommendations,
    opts.cfg,
    activeBiases,
  );
  const fallback = recommendations
    .filter((recommendation) => recommendation.agent_name !== opts.input.initial_agent)
    .find(
      (recommendation) =>
        configAgents.has(recommendation.agent_name) &&
        seatEnforcesInputProfile(opts.cfg, opts.input, recommendation.agent_name),
    );
  return fallback?.agent_name ?? null;
}

function earliestResetsAtForRefusals(outcomes: CapCheckRefuse[]): number | null {
  let earliest: number | null = null;
  for (const outcome of outcomes) {
    if (typeof outcome.resets_at !== "number") continue;
    if (earliest === null || outcome.resets_at < earliest) {
      earliest = outcome.resets_at;
    }
  }
  return earliest;
}

function recordPressureCapTrip(opts: {
  services: Services;
  input: ChainStartRequestWithLongLived;
  subject: "maestro" | "sub_agent";
  agent_name: string;
  maestro_agent_name: string;
  sub_agent_name: string;
  outcome: CapCheckRefuse;
}): void {
  const ts = opts.services.clock().toISOString();
  const payload = {
    ...opts.outcome,
    subject: opts.subject,
    trigger: "pre_dispatch",
    maestro_agent_name: opts.maestro_agent_name,
    sub_agent_name: opts.sub_agent_name,
  };

  opts.services.t0Writer.write({
    event_id: opts.services.uuid(),
    ts,
    ingest_ts: ts,
    source: "agentchat",
    source_detail: "chain-start",
    project_id: opts.input.project_id ?? null,
    user_id: "local-user",
    machine_id: opts.services.machineId.get(),
    session_id: opts.input.conversation_id ?? null,
    event_type: "subscription-pressure-cap-trip",
    lane: "cli-subscription",
    provider: opts.outcome.provider,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: payload,
    payload_summary: `${opts.subject}:${opts.outcome.provider}:${opts.outcome.window_label}`,
    origin: "maestro",
  });
}

function recordPressureFallbackEvent(opts: {
  services: Services;
  input: ChainStartRequestWithLongLived;
  maestroAgentName: string;
  originalAgentName: string;
  candidateAgent: string | null;
  candidateState: "refuse" | "selected" | "exhausted";
  candidateOutcome: ReturnType<typeof checkPressureCap>;
  attemptIndex: number;
  totalAttempts: number | null;
  ranking: {
    samples: number;
    success_rate: number;
    avg_latency_seconds: number | null;
  } | null;
  exhaustedReason?: "no_recommendations" | "no_candidates" | "all_refused" | "bias_excluded" | null;
}): void {
  const ts = opts.services.clock().toISOString();
  const payload = {
    parent_handoff_id: opts.input.parent_handoff_id ?? null,
    task_type: opts.input.task_type ?? null,
    original_agent: opts.originalAgentName,
    candidate_agent: opts.candidateAgent,
    candidate_state: opts.candidateState,
    candidate_provider: "provider" in opts.candidateOutcome ? opts.candidateOutcome.provider : null,
    candidate_window_label:
      "window_label" in opts.candidateOutcome ? opts.candidateOutcome.window_label : null,
    candidate_used_pct: "used_pct" in opts.candidateOutcome ? opts.candidateOutcome.used_pct : null,
    attempt_index: opts.attemptIndex,
    total_attempts: opts.totalAttempts,
    exhausted_reason: opts.exhaustedReason ?? null,
    ranking: opts.ranking,
    maestro_agent_name: opts.maestroAgentName,
    sub_agent_name: opts.input.initial_agent,
  };

  opts.services.t0Writer.write({
    event_id: opts.services.uuid(),
    ts,
    ingest_ts: ts,
    source: "agentchat",
    source_detail: "chain-start",
    project_id: opts.input.project_id ?? null,
    user_id: "local-user",
    machine_id: opts.services.machineId.get(),
    session_id: opts.input.conversation_id ?? null,
    event_type: "subscription-pressure-fallback",
    lane: "cli-subscription",
    provider: payload.candidate_provider,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: payload,
    payload_summary: `${payload.original_agent}:${payload.candidate_state}:${payload.candidate_agent ?? "none"}`,
    origin: "maestro",
  });
}

export function chainsHistoryRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const conversation_id = url.searchParams.get("conversation_id");
  if (!conversation_id) {
    return json(
      { error: { code: "missing_param", message: "conversation_id query parameter is required" } },
      400,
    );
  }
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const history = services.chainReader.listHistory(conversation_id, limit);
  return json({ history });
}

export function chainsResponsesRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const conversation_id = url.searchParams.get("conversation_id");
  if (!conversation_id) {
    return json(
      { error: { code: "missing_param", message: "conversation_id query parameter is required" } },
      400,
    );
  }
  const whichParam = url.searchParams.get("which");
  const which = whichParam === "all" ? "all" : "final";
  const handoffId = url.searchParams.get("handoff_id");
  if (handoffId !== null && handoffId.length === 0) {
    return json({ error: { code: "invalid_param", message: "handoff_id must be non-empty" } }, 400);
  }
  const responses = services.chainReader.getResponses(
    conversation_id,
    which,
    handoffId ? { handoff_id: handoffId } : {},
  );
  if (responses.length === 0 && !services.chainReader.conversationExists(conversation_id)) {
    return json(
      { error: { code: "not_found", message: "no chain events found for conversation" } },
      404,
    );
  }
  return json({ responses });
}

export { chainsMessagesRoute } from "./chains-messages.js";

export async function chainSendMessageRoute(
  req: Request,
  handoff_id: string,
  services: Services,
): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) {
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );
  }
  if (typeof raw !== "object" || typeof (raw as Record<string, unknown>).content !== "string") {
    return json(
      { error: { code: "validation_error", message: "body must include content:string" } },
      400,
    );
  }
  const { content } = raw as { content: string };
  const normalizedContent = content.trim();
  if (normalizedContent.length === 0) {
    return json({ error: { code: "validation_error", message: "content must be non-empty" } }, 400);
  }

  const handoff = services.handoffReader.get(handoff_id);
  if (!handoff) {
    return json({ error: { code: "not_found", message: `handoff ${handoff_id} not found` } }, 404);
  }
  if (isTerminalHandoffStatus(handoff.status)) {
    return json(
      { error: { code: "gone", message: `handoff ${handoff_id} is no longer running` } },
      410,
    );
  }

  const workerManager = services.workerManager;
  if (!workerManager || typeof workerManager.lookupSession !== "function") {
    return json({ error: { code: "not_found", message: `handoff ${handoff_id} not found` } }, 404);
  }

  const rawSession = await workerManager.lookupSession(handoff_id);
  if (!rawSession) {
    return json({ error: { code: "not_found", message: `handoff ${handoff_id} not found` } }, 404);
  }
  const session = rawSession as {
    adapter?: string | null;
    adapter_kind?: string | null;
    metadata?: { adapter?: string | null; adapter_kind?: string | null } | null;
    worker?: { adapter?: string | null; adapter_kind?: string | null } | null;
    inject?: (msg: { role: string; text: string }) => Promise<unknown>;
  };
  const adapterId = resolveAdapterId(session);
  if (!supportsMidSessionInject(adapterId)) {
    return json(
      {
        error: {
          code: "unsupported_adapter",
          message: `adapter does not support mid-session inject: ${adapterId || "unknown"}`,
        },
      },
      409,
    );
  }
  if (typeof session.inject !== "function") {
    return json(
      {
        error: {
          code: "unsupported_adapter",
          message: `adapter does not support mid-session inject: ${adapterId || "unknown"}`,
        },
      },
      409,
    );
  }

  await session.inject({ role: "user", text: normalizedContent });
  return json({ ok: true });
}

// #256: the seat's last local health probe as chain_list_agents shows it, or
// undefined when the gate is off, the service has no getSeatHealth, or the seat
// was never probed.
function chainAgentHealth(
  services: Services,
  name: string,
): { state: string; checked_at: string; http_status?: number } | undefined {
  const record = services.localSeatHealth?.getSeatHealth?.(name);
  if (record === undefined) {
    return undefined;
  }
  return {
    state: record.state,
    checked_at: new Date(record.checkedAtMs).toISOString(),
    ...(record.httpStatus === undefined ? {} : { http_status: record.httpStatus }),
  };
}

export function chainsListAgentsRoute(_req: Request, services: Services): Response {
  const agents = (services.agentRegistry ?? []).map((name) => {
    const health = chainAgentHealth(services, name);
    return health === undefined ? { name } : { name, health };
  });
  return json({ agents });
}

const ChainsListQuerySchema = z
  .object({
    status: HandoffStatusSchema.optional(),
    project_id: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

export function chainsListRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const parsed = ChainsListQuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    project_id: url.searchParams.get("project_id") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    offset: url.searchParams.get("offset") ?? undefined,
  });
  if (!parsed.success) {
    return json(
      {
        error: {
          code: "invalid_input",
          details: parsed.error.issues,
        },
      },
      400,
    );
  }
  const limit = parsed.data.limit ?? 100;
  const offset = parsed.data.offset ?? 0;
  const chains = services.chainReader.listChains({
    status: parsed.data.status,
    project_id: parsed.data.project_id,
    limit,
    offset,
  });
  return json({ chains, limit, offset });
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function resolveAdapterId(session: {
  adapter?: string | null;
  adapter_kind?: string | null;
  metadata?: { adapter?: string | null; adapter_kind?: string | null } | null;
  worker?: { adapter?: string | null; adapter_kind?: string | null } | null;
}): string {
  return (
    session.adapter ??
    session.adapter_kind ??
    session.metadata?.adapter ??
    session.metadata?.adapter_kind ??
    session.worker?.adapter ??
    session.worker?.adapter_kind ??
    ""
  );
}

function readOptionalBooleanField(
  raw: unknown,
  field: string,
): { value: boolean | undefined; error?: string } {
  if (!raw || typeof raw !== "object") return { value: undefined };
  const value = (raw as Record<string, unknown>)[field];
  if (value === undefined) return { value: undefined };
  if (typeof value === "boolean") return { value };
  return { value: undefined, error: "Invalid input: expected boolean, received non-boolean" };
}

function readOptionalStringField(
  raw: unknown,
  field: string,
): { value: string | undefined; error?: string } {
  if (!raw || typeof raw !== "object") return { value: undefined };
  const value = (raw as Record<string, unknown>)[field];
  if (value === undefined) return { value: undefined };
  if (typeof value === "string" && value.length > 0) return { value };
  return {
    value: undefined,
    error: "Invalid input: expected non-empty string, received non-string or empty value",
  };
}

function readOptionalDispatchKindField(
  raw: unknown,
  field: string,
): { value: DispatchKind | undefined; error?: string } {
  const parsed = readOptionalStringField(raw, field);
  if (parsed.error) return { value: undefined, error: parsed.error };
  if (parsed.value === undefined) return { value: undefined };
  if (parsed.value in DISPATCH_KIND_SET) return { value: parsed.value as DispatchKind };
  return {
    value: undefined,
    error: `Invalid input: expected one of ${DISPATCH_KIND_ERROR_LIST}`,
  };
}

function readOptionalWorkloadField(
  raw: unknown,
  field: string,
): { value: Workload | undefined; error?: string } {
  const parsed = readOptionalStringField(raw, field);
  if (parsed.error) return { value: undefined, error: parsed.error };
  if (parsed.value === undefined) return { value: undefined };
  if ((WORKLOADS as readonly string[]).includes(parsed.value)) {
    return { value: parsed.value as Workload };
  }
  return { value: undefined, error: `Invalid input: expected one of ${WORKLOADS.join(", ")}` };
}

function longLivedError(
  input: ChainStartRequestWithLongLived,
  body: Record<string, unknown>,
): { message: string; errorResponse: Response } {
  return { message: input.message, errorResponse: json({ error: body }, 400) };
}

function resolveLongLivedAgentAndTick(
  input: ChainStartRequestWithLongLived,
  services: Services,
):
  | {
      ok: true;
      agent: LongLivedPromptAgentRow;
      tick: LongLivedPromptTickRow;
      agentId: string;
      tickId: string;
    }
  | { ok: false; errorResult: { message: string; errorResponse: Response } } {
  const agentId = input.long_lived_agent_id ?? null;
  if (!agentId) {
    return {
      ok: false,
      errorResult: longLivedError(input, {
        code: "unknown_long_lived_agent",
        message: "long-lived dispatch requires a resolvable agent",
        long_lived_agent_id: input.long_lived_agent_id ?? null,
      }),
    };
  }
  const tickId = input.long_lived_tick_id ?? null;
  if (!tickId) {
    return {
      ok: false,
      errorResult: longLivedError(input, {
        code: "unknown_long_lived_tick",
        message: "long-lived dispatch requires a resolvable tick",
        long_lived_tick_id: input.long_lived_tick_id ?? null,
      }),
    };
  }
  const agent = services.db
    .query<LongLivedPromptAgentRow, [string]>(
      `SELECT id, display_name, standing_brief, working_memory_json, mcp_allowlist_json,
            bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches
     FROM long_lived_agents
     WHERE id = ?
     LIMIT 1`,
    )
    .get(agentId);
  if (!agent) {
    return {
      ok: false,
      errorResult: longLivedError(input, {
        code: "unknown_long_lived_agent",
        message: `long-lived agent not found: ${agentId}`,
        long_lived_agent_id: agentId,
      }),
    };
  }
  const tick = services.db
    .query<LongLivedPromptTickRow, [string]>(
      `SELECT id, agent_id, trigger_kind, trigger_payload_json
     FROM long_lived_ticks
     WHERE id = ?
     LIMIT 1`,
    )
    .get(tickId);
  if (!tick) {
    return {
      ok: false,
      errorResult: longLivedError(input, {
        code: "unknown_long_lived_tick",
        message: `long-lived tick not found: ${tickId}`,
        long_lived_tick_id: tickId,
      }),
    };
  }
  if (tick.agent_id !== agent.id) {
    return {
      ok: false,
      errorResult: longLivedError(input, {
        code: "cross_identity_long_lived",
        message: "long-lived tick does not belong to the provided agent",
        long_lived_agent_id: agentId,
        long_lived_tick_id: tickId,
      }),
    };
  }
  return { ok: true, agent, tick, agentId, tickId };
}

function buildStampedLongLivedPrompt(
  input: ChainStartRequestWithLongLived,
  services: Services,
): {
  message: string;
  errorResponse?: Response;
} {
  if (input.dispatch_kind !== "long_lived_tick") {
    return { message: input.message };
  }

  const resolved = resolveLongLivedAgentAndTick(input, services);
  if (!resolved.ok) return resolved.errorResult;
  const { agent, tick } = resolved;

  const agentHostedNames = new Set<string>();
  for (const entry of parseJsonWithFallback<string[]>(agent.mcp_allowlist_json, [])) {
    const separator = entry.includes(":") ? entry.indexOf(":") : entry.indexOf(".");
    if (separator <= 0) continue;
    const server = entry.slice(0, separator);
    if (server) agentHostedNames.add(server);
  }
  const unavailableServers =
    agentHostedNames.size > 0 && services.mcpPool
      ? services.mcpPool
          .getFederationHealth()
          .skipped.filter((s) => agentHostedNames.has(s.server))
          .map((s) => s.server)
      : [];

  return {
    message: stampPrompt({
      agent: {
        id: agent.id,
        display_name: agent.display_name,
        standing_brief: agent.standing_brief,
        working_memory: parseJsonWithFallback(agent.working_memory_json, {
          version: 1,
          updated_at: services.clock().getTime(),
          pending_goals: [],
          open_threads: [],
          watches: [],
          recent_decisions: [],
        }),
        mcp_allowlist: parseJsonWithFallback<string[]>(agent.mcp_allowlist_json, []),
        unavailable_servers: unavailableServers,
        bounds: {
          wall_clock_ms: agent.bounds_wall_clock_ms ?? 1_800_000,
          cost_cents: agent.bounds_cost_cents ?? 200,
          max_sub_dispatches: agent.bounds_max_sub_dispatches ?? 10,
        },
      },
      tick: {
        id: tick.id,
        trigger_kind: tick.trigger_kind,
        trigger_payload: parseJsonWithFallback<unknown>(tick.trigger_payload_json, null),
        now_iso: services.clock().toISOString(),
      },
    }),
  };
}

function parseJsonWithFallback<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isTerminalHandoffStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "rejected";
}

function resolveInitialRoute(opts: {
  initialAgent: string;
  message: string;
  taskType?: AgentTaskType;
  forceExactAgent: boolean;
  services: Services;
  harness?: RouterHarnessHints;
}): RouteResolution {
  const { agentRegistry, agentRouting } = opts.services;
  const roleAgents = (agentRouting?.agents ?? [])
    .filter((agent) => agent.roles.includes(opts.initialAgent))
    .map((agent) => agent.name)
    .filter((name) => !agentRegistry || agentRegistry.includes(name));
  const isKnownRole =
    agentRouting !== null &&
    (Object.hasOwn(agentRouting.default_roles, opts.initialAgent) ||
      agentRouting.agents.some((agent) => agent.roles.includes(opts.initialAgent)));
  const shouldExploreZeroHolderRole =
    isKnownRole && opts.services.taskRouterConfig?.mode === "auto";
  if (
    !opts.forceExactAgent &&
    agentRouting &&
    (roleAgents.length > 0 || shouldExploreZeroHolderRole)
  ) {
    return resolveRoleRoute(opts, roleAgents);
  }

  if (agentRegistry?.includes(opts.initialAgent)) {
    return {
      route: { agent: opts.initialAgent, role: null, taskType: null },
      decision: null,
      roleRouteAttempted: false,
    };
  }
  return { route: null, decision: null, roleRouteAttempted: false };
}

function resolveRoleRoute(
  opts: {
    initialAgent: string;
    message: string;
    taskType?: AgentTaskType;
    services: Services;
    harness?: RouterHarnessHints;
  },
  roleAgents: string[],
): RouteResolution {
  const taskType = opts.taskType ?? inferTaskTypeForRole(opts.message, opts.initialAgent);
  const decisionSink: RouterDecisionSink = { decision: null };
  const route = resolveSingleRoute(opts.services, opts.initialAgent, opts.message, taskType, {
    ...opts.harness,
    decisionSink,
  });
  if (!route && roleAgents.length === 0) {
    return { route: null, decision: decisionSink.decision, roleRouteAttempted: true };
  }
  if (!route && opts.services.taskRouterConfig?.mode === "auto") {
    // resolveSingleRoute already ran the constraint-aware selector; auto mode
    // must not refill that denied pool with the first strict role holder. A
    // router null always fails closed here, including non-provider constraint
    // failures, because the router is the constraint authority and
    // roleAgents[0] is an unconstrained legacy refill. Legacy modes keep the
    // fallback below.
    return { route: null, decision: decisionSink.decision, roleRouteAttempted: true };
  }
  const fallbackAgent = roleAgents[0] ?? opts.initialAgent;
  return {
    route: route ?? { agent: fallbackAgent, role: opts.initialAgent, taskType },
    decision: decisionSink.decision,
    roleRouteAttempted: true,
  };
}

function inferTaskTypeForRole(message: string, role: string): AgentTaskType {
  return inferAgentTaskTypeForRole(message, role);
}

function makeGetRecentDispatchCount(
  services: Services,
): (provider: string, windowSeconds: number) => number {
  return (provider: string, windowSeconds: number): number => {
    const cfg = services.agentchatConfig;
    if (!cfg?.agents) return 0;
    const agentsForProvider = cfg.agents
      .filter(
        (a) =>
          (a.pricing_mode === "subscription"
            ? a.subscription_provider
            : (a.api_provider ?? a.subscription_provider)) === provider,
      )
      .map((a) => a.name);
    if (agentsForProvider.length === 0) return 0;
    const cutoff = new Date(services.clock().getTime() - windowSeconds * 1000).toISOString();
    const placeholders = agentsForProvider.map(() => "?").join(",");
    const row = services.db
      .query<
        { c: number },
        (string | number)[]
      >(`SELECT COUNT(*) as c FROM handoffs WHERE to_agent IN (${placeholders}) AND ts >= ?`)
      .get(...agentsForProvider, cutoff);
    return row?.c ?? 0;
  };
}
