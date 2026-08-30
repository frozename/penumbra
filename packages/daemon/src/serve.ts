import type { loadShellConfig } from "@penumbra/agentchat/worker/shell-config";

import { getAgentDescriptor } from "@penumbra/agentchat";
import {
  getConfig,
  loadModelAliasMapFromDir,
  loadTaskRouterConfigFromDir,
  type ModelAliasMap,
  type TaskRouterConfig,
  TaskRouterConfigSchema,
} from "@penumbra/config";
import {
  type AgentDescriptor,
  AgentPerformanceWriter,
  type ChainStartRequest,
  checkEmbeddingModelVersion,
  type Services as CoreServices,
  createAaSnapshotStore,
  installGlobalCrashHandlers,
  ledgerWriteToPerformanceRow,
  MaestroSessionWriter,
  mapTaskEventToLedger,
  readRoutingBiases,
  readStoredEmbeddingModelVersion,
  resolveProjectId,
  runStartupZombieSweep,
  TaskCooldowns,
  type TaskEvent,
  TaskEventBus,
  type TaskLeaseRow,
  TaskWriter,
  type Watchdog,
} from "@penumbra/core";
import { resolveGateOutcomeCutoverIso, WorkerTokenStore } from "@penumbra/core";
import {
  composeRecall,
  computeStateMetrics,
  executeWorkflow,
  type TemplateVarContext,
  type WorkflowFn,
  type WorkflowSpec,
} from "@penumbra/workflows";
import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { GhClient } from "./services/gh-client.js";

import {
  createJudgeChat,
  type ResolvedJudgeConfig,
  resolveJudgeConfig,
} from "../../core/src/services/judge-chat.js";
import {
  type LlmCandidate,
  type LlmServingCandidate,
  type ResolveKeychainSecret,
  resolveRoleLlmCandidates,
} from "../../core/src/services/llm-candidates.js";
import { resolveAgentChatConfigPath } from "./agentchat-config.js";
import { createBearerAuth } from "./auth.js";
import { corsPreflightResponse, withCorsResponseHeaders } from "./cors.js";
import { buildDreamingConfig, type DreamConfig } from "./dreaming/config.js";
import { buildDreamCycleDeps } from "./dreaming/deps.js";
import { startDailyDigestCron, startDreamingCron } from "./dreaming/index.js";
import { resolveDreamRuntimeConfig } from "./dreaming/runtime-config.js";
import { getMcpEventBus } from "./events/mcp-event-bus.js";
import { LagSampler } from "./lag-sampler.js";
import { buildActionGateCallbacks } from "./long-lived/action-gate-callbacks.js";
import { createActionGate } from "./long-lived/action-gate.js";
import { createMcpPool } from "./long-lived/mcp-pool.js";
import { type AcpWorkerManagerLike, createAcpInjector } from "./maestro/acp-injector.js";
import { createBoundsCallbacks } from "./maestro/bounds-callbacks.js";
import { createBoundsTracker } from "./maestro/bounds-tracker.js";
import { runRestartResume } from "./maestro/restart-resume.js";
import { createHttpWorkerManager } from "./maestro/worker-manager-http.js";
import { createOriginHostGuard } from "./origin-host.js";
import { createLongLivedReactor } from "./reactors/long-lived-reactor.js";
import { createOrchestrateReactor } from "./reactors/orchestrate-reactor.js";
import {
  agentsFleetLatencyRoute,
  agentsPerformanceDispatchRoute,
  agentsPerformanceImportMarkdownRoute,
  agentsPerformanceMarkdownRoute,
  agentsPerformanceOperatorRoute,
  agentsPerformanceReconcilerRoute,
  agentsRankRoute,
  agentsRecommendRoute,
  agentsRouteForRoute,
} from "./routes/agents.js";
import {
  chainSendMessageRoute,
  chainsHistoryRoute,
  chainsListAgentsRoute,
  chainsListRoute,
  chainsMessagesRoute,
  chainsResponsesRoute,
  chainsStartRoute,
  chainStartInternal,
} from "./routes/chains.js";
import { conversationStreamRoute } from "./routes/conversation-stream.js";
import { conversationsCancelRoute } from "./routes/conversations.js";
import {
  curatorPatternsAddRoute,
  curatorPatternsApproveRoute,
  curatorPatternsDisableRoute,
  curatorPatternsListRoute,
} from "./routes/curator.js";
import { dispatchAuditRoute } from "./routes/dispatch-audit.js";
import {
  dispatchEventsGetRoute,
  dispatchEventsPostRoute,
  dispatchEventsStreamRoute,
} from "./routes/dispatch-events.js";
import { dispatchLandRoute, dispatchLandTaskRoute } from "./routes/dispatch-land.js";
import { makeDispatchRefineRoute } from "./routes/dispatch-refine.js";
import {
  dreamingApplyRoute,
  dreamingHealthRoute,
  dreamingPendingActionsRoute,
  dreamingRevertRoute,
} from "./routes/dreaming.js";
import {
  worktreesEditRoute,
  worktreesExecRoute,
  worktreesGlobRoute,
  worktreesGrepRoute,
  worktreesReadRoute,
  worktreesWriteRoute,
} from "./routes/fs.js";
import { handoffsEventsRoute } from "./routes/handoffs-events.js";
import { handoffsProgressRoute } from "./routes/handoffs-progress.js";
import {
  handoffsApproveRoute,
  handoffsClaimRoute,
  handoffsCompleteRoute,
  handoffsCreateRoute,
  handoffsFailRoute,
  handoffsGetRoute,
  handoffsLatestRoute,
  handoffsListPendingRoute,
  handoffsRecordBranchRoute,
  handoffsStatusRoute,
} from "./routes/handoffs.js";
import { healthRoute } from "./routes/health.js";
import { lanesCloseRoute, lanesOpenRoute, lanesRecentRoute } from "./routes/lanes.js";
import { longLivedFederationHealthRoute } from "./routes/long-lived-federation-health.js";
import { longLivedFederationToolsRoute } from "./routes/long-lived-federation-tools.js";
import { longLivedMcpCallRoute } from "./routes/long-lived-mcp.js";
import {
  longLivedApproveActionRoute,
  longLivedAuditRoute,
  longLivedGetRoute,
  longLivedInjectGoalRoute,
  longLivedListRoute,
  longLivedPauseRoute,
  longLivedPendingActionsRoute,
  longLivedReconcileOrphansRoute,
  longLivedRejectActionRoute,
  longLivedResumeRoute,
  longLivedRetireRoute,
  longLivedStateGetRoute,
  longLivedStateSetRoute,
  longLivedStreamRoute,
  longLivedTickRoute,
  longLivedTicksRoute,
} from "./routes/long-lived.js";
import {
  maestroCapabilitiesRoute,
  maestroSessionGetRoute,
  maestroSessionStartAdhocRoute,
  maestroSessionStartRoute,
} from "./routes/maestro.js";
import { mcpEventsPublishRoute } from "./routes/mcp-events.js";
import { memorySessionExtractRoute } from "./routes/memory-session-extract.js";
import { memoryVerifyAuthorizeRoute } from "./routes/memory-verify.js";
import {
  memoryCorpusBuildRoute,
  memoryCorpusListRoute,
  memoryCorpusQueryRoute,
  memoryEfficacyJobRoute,
  memoryEfficacyJobsRoute,
  memoryEfficacyRebuildRoute,
  memoryEfficacyRecentRoute,
  memoryGetRoute,
  memorySearchRoute,
  memoryStatusRoute,
  memoryTimelineRoute,
  memoryVerificationEventsRoute,
  memoryVerifyRoute,
  memoryWriteT2Route,
} from "./routes/memory.js";
import { metricsRoute } from "./routes/metrics.js";
import { observationsRoute } from "./routes/observations.js";
import { otlpLogsRoute, otlpMetricsRoute, otlpTracesRoute } from "./routes/otlp.js";
import { permissionsEventsRoute } from "./routes/permissions-events.js";
import {
  permissionsCreateRoute,
  permissionsDecideRoute,
  permissionsGetRoute,
  permissionsListRoute,
} from "./routes/permissions.js";
import {
  plansCancelRoute,
  plansGetRoute,
  plansListRoute,
  plansRegisterRoute,
} from "./routes/plans.js";
import { qualityStatusRoute } from "./routes/quality.js";
import { recallRoute } from "./routes/recall.js";
import { reconcilerSweepOrphanPrsRoute, reconcilerVerdictsRoute } from "./routes/reconciler.js";
import {
  registrarAppendRoute,
  registrarCreateRoute,
  registrarGetRoute,
  registrarListEventsRoute,
  registrarListRoute,
} from "./routes/registrar.js";
import { reloadConfigRoute } from "./routes/reload-config.js";
import {
  routingBiasClearRoute,
  routingBiasListRoute,
  routingBiasSetRoute,
} from "./routes/routing-bias.js";
import { sessionEndRoute } from "./routes/session-end.js";
import { sessionCurrentRoute, sessionsTouchRoute } from "./routes/sessions.js";
import { shellCloseRoute, shellListRoute, shellRunRoute } from "./routes/shell.js";
import { taskDraftsPendingEscalationsRoute, taskDraftsPendingRoute } from "./routes/task-drafts.js";
import { tasksEventsRoute } from "./routes/tasks-events.js";
import {
  tasksCancelRoute,
  tasksCommentGhRoute,
  tasksCompleteRoute,
  tasksFailRoute,
  tasksFileRoute,
  tasksGetRoute,
  tasksHeartbeatRoute,
  tasksLeaseRoute,
  tasksLinkGhRoute,
  tasksListRoute,
  tasksSyncGhNowRoute,
  tasksUnlinkGhRoute,
} from "./routes/tasks.js";
import {
  usageQuotaStatusRoute,
  usageRecentRoute,
  usageSubscriptionPressureRoute,
} from "./routes/usage.js";
import { workerControlRoute } from "./routes/worker-control.js";
import { workerHeartbeatRoute } from "./routes/worker-heartbeat.js";
import { workerProbeAckRoute } from "./routes/worker-probe-ack.js";
import { workerReconcileOrphansRoute } from "./routes/worker-reconcile-orphans.js";
import { workerRegisterRoute } from "./routes/worker-register.js";
import {
  workflowsHistoryRoute,
  workflowsListRoute,
  workflowsRunRoute,
  workflowsStatusRoute,
  workflowsSuggestRoute,
  workflowsTriggerRoute,
  workflowsWaitRoute,
} from "./routes/workflows.js";
import { workspaceRoute } from "./routes/workspace.js";
import {
  worktreesCleanupRoute,
  worktreesInspectRoute,
  worktreesListRoute,
} from "./routes/worktrees.js";
import { createLocalSeatHealthService } from "./services/local-seat-health.js";
import { OrphanHandoffRecoveryService } from "./services/orphan-handoff-recovery.js";
import {
  buildRequiredLlmRoleFloors,
  evaluateLlmRoleFloors,
  type LlmRoleFloorEvaluation,
  logLlmRoleFloorViolations,
  recordSubsystemOutcome,
} from "./services/subsystem-health.js";
import { WatchdogService } from "./services/watchdog.js";
import { createWorkerHealthController, WorkerHealthProbe } from "./services/worker-health-probe.js";
import {
  DEFAULT_AA_SNAPSHOT_REFRESH_INTERVAL_MS,
  startAaSnapshotRefreshSweeper,
} from "./sweepers/aa-snapshot-refresh.js";
import { startEfficacyJobReclaimSweeper } from "./sweepers/efficacy-job-reclaim.js";
import { startGateQualityDigestSweeper } from "./sweepers/gate-quality-digest.js";
import {
  createDefaultGhTaskSyncService,
  createGhTaskSyncSingleFlight,
  createGhTaskSyncSweeper,
  type GhTaskSyncService,
} from "./sweepers/gh-task-sync.js";
import { startNotificationSweeper } from "./sweepers/notification-sweeper.js";
import { createOrchestrateDeferralSweeper } from "./sweepers/orchestrate-deferral.js";
import { startOrphanLanesSweeper } from "./sweepers/orphan-lanes.js";
import { startPermissionTtlSweeper } from "./sweepers/permission-ttl.js";
import { createPlanRuntimeSweeper } from "./sweepers/plan-runtime.js";
import { installPrOrphanSweeper } from "./sweepers/pr-orphan-sweeper.js";
import {
  DEFAULT_PROVIDER_DRIFT_SWEEP_INTERVAL_MS,
  PROVIDER_DRIFT_DRY_RUN_ARGV,
  startProviderDriftSweeper,
} from "./sweepers/provider-drift.js";
import { startReconcilerSweeper } from "./sweepers/reconciler-sweep.js";
import { createRefiningStuckRecoverySweeper } from "./sweepers/refining-stuck-recovery.js";
import { resolveStaleAfterMs } from "./sweepers/stale-handoff-thresholds.js";
import { startStaleHandoffSweeper } from "./sweepers/stale-handoff.js";
import { startStaleWorkerTokensSweeper } from "./sweepers/stale-worker-tokens.js";
import { createTaskLeaseSweeper } from "./sweepers/task-leases.js";
import { startWorkflowTriggerSweeper } from "./sweepers/workflow-trigger.js";
import { startWorktreeGcSweeper } from "./sweepers/worktree-gc.js";
import { type ExtraWorkerConfig, loadExtraWorkersConfig } from "./workers/config.js";
import { createDispatchEventsRetentionWorker } from "./workers/dispatch-events-retention.js";
import { createHandoffSweeperWorker } from "./workers/handoff-sweeper.js";
import { createMemoryEfficacyJobRunner } from "./workers/memory-efficacy-job-runner.js";
import { ExtraWorkerSupervisor } from "./workers/supervisor.js";
import { createT0RetentionWorker } from "./workers/t0-retention.js";
import { createRollupWorker } from "./workers/t1-rollup.js";
import { createT2PromotionWorker } from "./workers/t2-promotion.js";

type Services = CoreServices;

export interface ServeOpts {
  services: Services;
  token: string;
  port: number;
  hostname?: string;
  /** Called after supervisor and HTTP server are stopped. Use to release resources (e.g. db.close()). */
  onStop?: () => void;
}

export interface DaemonHandle {
  port: number;
  stop(): Promise<void>;
}

export type DaemonServices = CoreServices & {
  taskRouterConfig: TaskRouterConfig;
  modelAliasMap: ModelAliasMap;
  // Override for the AA snapshot store's on-disk path, consumed by
  // reloadTaskRouterConfigSubsystem. Absent in production (defaults to
  // ~/.penumbra/aa-snapshot.json); tests set this to a temp path so a
  // reload doesn't touch the operator's real snapshot file.
  aaSnapshotPath?: string;
  agentchatConfig?: {
    agents?: { name: string; roles?: string[]; [key: string]: unknown };
    providers?: { name: string; model: string; [key: string]: unknown }[];
    [key: string]: unknown;
  };
  shellConfig?: ReturnType<typeof loadShellConfig>;
  workflowDirs?: { playbooksDir: string; workflowsDir: string };
  watchdog?: Watchdog;
  orphanHandoffRecovery?: OrphanHandoffRecoveryService;
  extraWorkerSupervisor?: ExtraWorkerSupervisor;
  workerAuthz?: Map<string, { project_id?: string; isolation: ExtraWorkerConfig["isolation"] }>;
  workerHealthProbe?: WorkerHealthProbe;
  llmRoleFloorEvaluation?: LlmRoleFloorEvaluation;
};

// Returns the single captured group from `pattern.exec(input)`, or undefined.
// Lets callers route on the captured value without a non-null assertion.
function pathParam(pattern: RegExp, input: string): string | undefined {
  return pattern.exec(input)?.[1];
}

// Returns the first two captured groups as a tuple, or undefined when the
// pattern does not match or either capture is absent.
function pathParamPair(pattern: RegExp, input: string): [string, string] | undefined {
  const match = pattern.exec(input);
  if (!match) return undefined;
  const a = match[1];
  const b = match[2];
  if (a === undefined || b === undefined) return undefined;
  return [a, b];
}

// Concrete shape of the workflow registry entries this file consumes. The core
// WorkflowRegistry types specs as `unknown`, but the workflows package always
// hands back `WorkflowSpec` entries — this is the single typed bridge.
interface WorkflowTriggerEntry {
  spec: WorkflowSpec;
  fn?: WorkflowFn;
}

// Returns the first argument that is a non-empty string. Used where `||` would
// also reject empty-string falsy values (and so `??` cannot replace it directly).
function firstNonEmpty(...candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== "") return candidate;
  }
  return "";
}

// Best-effort info log for code paths invoked by tests that pass a partial
// Services where `log` is intentionally unset. Production callers always
// supply a real Logger; this helper exists only so the same code path is safe
// in stub-services tests.
function safeLogInfo(services: Services, payload: Record<string, unknown>, msg: string): void {
  // `services.log` is typed as required, but tests construct services via
  // `as unknown as Services`. Cast to unknown first to allow optional access.
  const log = (services as unknown as { log?: { info?: (obj: unknown, m: string) => void } }).log;
  log?.info?.(payload, msg);
}

function evaluateStartupLlmRoleFloors(opts: ServeOpts, dreamConfig: DreamConfig): void {
  const daemonServices = opts.services as DaemonServices;
  const evaluation = evaluateLlmRoleFloors({
    agentchatConfig: opts.services.agentchatConfig,
    requiredRoles: buildRequiredLlmRoleFloors({
      dreamingAutoPromoteMinJudges: dreamConfig.autoPromoteMinJudges,
    }),
  });
  daemonServices.llmRoleFloorEvaluation = evaluation;
  logLlmRoleFloorViolations({ log: opts.services.log, evaluation });
}

async function runWorkflowTriggerEntry(
  opts: ServeOpts,
  name: string,
  cwd: string,
  project: string,
): Promise<void> {
  const reg = opts.services.workflowRegistry;
  if (!reg) return;
  const entry = reg.getEntry(name) as WorkflowTriggerEntry | undefined;
  if (!entry) return;
  const start = Date.now();
  const templateCtx: TemplateVarContext = {
    now: () => new Date(),
    project,
    sessionStart: new Date(start).toISOString(),
    tz: process.env.TZ ?? "UTC",
    cwd,
    repoRoot: cwd,
  };
  const services = opts.services;
  const registry = services.agentRegistry;
  const agentRegistry = registry
    ? { listAgents: (): { name: string }[] => registry.map((name) => ({ name })) }
    : undefined;
  const bundle = await composeRecall({
    db: services.db,
    embedder: services.embedder,
    cwd,
    project,
    sources: entry.spec.recall,
    budgetTokens: entry.spec.recall_budget_tokens,
    agentRegistry,
    templateCtx,
  });
  await executeWorkflow({
    spec: entry.spec,
    bundle,
    fn: entry.fn,
    storageRoot: opts.services.storageRoot,
    captureCtx: {
      db: opts.services.db,
      project,
      sessionId: "sweeper",
      userId: "penumbra",
      machineId: process.env.HOSTNAME ?? "unknown",
    },
    captureKind: "refresh",
  });
}

function resolveLedgerLeaseRow(services: Services, event: TaskEvent): TaskLeaseRow | undefined {
  if (event.kind === "released" && event.payload?.reason === "expired") {
    const leaseId = typeof event.payload.lease_id === "string" ? event.payload.lease_id : null;
    if (!leaseId) return undefined;
    return (
      services.db
        .query<TaskLeaseRow, [string]>(
          `SELECT id, task_id, agent_id, claimed_at, expires_at, released_at, release_reason, auction_score
         FROM task_leases
         WHERE id = ?
         LIMIT 1`,
        )
        .get(leaseId) ?? undefined
    );
  }

  if (event.kind === "completed") {
    return (
      services.db
        .query<TaskLeaseRow, [string]>(
          `SELECT id, task_id, agent_id, claimed_at, expires_at, released_at, release_reason, auction_score
         FROM task_leases
         WHERE task_id = ? AND release_reason = 'completed'
         ORDER BY claimed_at DESC
         LIMIT 1`,
        )
        .get(event.task_id) ?? undefined
    );
  }

  if (event.kind === "review_passed" || event.kind === "review_failed") {
    return (
      services.db
        .query<TaskLeaseRow, [string]>(
          `SELECT id, task_id, agent_id, claimed_at, expires_at, released_at, release_reason, auction_score
         FROM task_leases
         WHERE task_id = ? AND release_reason = 'completed'
         ORDER BY claimed_at DESC
         LIMIT 1`,
        )
        .get(event.task_id) ?? undefined
    );
  }

  return undefined;
}

function startTaskLedgerCapture(opts: {
  services: Services;
  taskEvents: TaskEventBus;
  taskWriter: TaskWriter;
}): void {
  const project_id = ((): string | null => {
    try {
      return resolveProjectId({ cwd: process.cwd() }).project_id ?? null;
    } catch {
      return null;
    }
  })();

  const perfWriter = new AgentPerformanceWriter(opts.services.db);
  const watched = new Set(["completed", "review_passed", "review_failed", "released"]);

  const iterator = opts.taskEvents.subscribe((event: TaskEvent): boolean =>
    watched.has(event.kind),
  );
  void (async (): Promise<void> => {
    for await (const event of iterator) {
      try {
        const taskRow = opts.taskWriter.get(event.task_id);
        const leaseRow = resolveLedgerLeaseRow(opts.services, event);
        const write = mapTaskEventToLedger(event, taskRow, leaseRow);
        if (!write) continue;
        const row = ledgerWriteToPerformanceRow({
          write,
          taskEvent: event,
          project_id,
          clock: opts.services.clock,
          uuid: opts.services.uuid,
        });
        perfWriter.upsert(row);
      } catch (error) {
        try {
          opts.services.log.warn(
            {
              err: error,
              task_id: event.task_id,
              kind: event.kind,
            },
            "task->ledger write failed",
          );
        } catch {
          // keep subscriber resilient when log is missing in partial test services
        }
      }
    }
  })();
}

interface HandoffConversationRow {
  conversation_id: string;
}

async function cancelChainByHandoffId(services: Services, chain_handoff_id: string): Promise<void> {
  const row = services.db
    .query<
      HandoffConversationRow | null,
      [string]
    >("SELECT conversation_id FROM handoffs WHERE handoff_id = ? LIMIT 1")
    .get(chain_handoff_id);
  if (!row?.conversation_id) {
    console.warn(`[bounds-callbacks] cannot cancel chain; handoff not found: ${chain_handoff_id}`);
    return;
  }

  const response = conversationsCancelRoute(
    new Request(`http://localhost/conversations/${row.conversation_id}/cancel`, { method: "POST" }),
    row.conversation_id,
    services,
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`conversation cancel failed (${String(response.status)}): ${body}`);
  }
}

// Bundle of per-request collaborators the route handlers reach into. Built once
// per createDaemonFetchHandler invocation and passed by reference to dispatch.
interface RouteCtx {
  services: Services;
  daemonServices: DaemonServices;
  taskWriter: TaskWriter;
  taskEvents: TaskEventBus;
  ghTaskSyncService: GhTaskSyncService;
  workerTokenStore: WorkerTokenStore;
  dispatchRefineHandler: (req: Request) => Promise<Response>;
  orphanHandoffRecovery: OrphanHandoffRecoveryService | undefined;
  workerHealthProbe: WorkerHealthProbe | undefined;
  lagSampler: LagSampler | undefined;
}

type StaticRouteHandler = (req: Request, ctx: RouteCtx) => Promise<Response> | Response;
type CapturingRouteHandler = (
  req: Request,
  ctx: RouteCtx,
  id: string,
) => Promise<Response> | Response;

interface StaticRoute {
  method: "GET" | "POST";
  // Exact string match, or prefix-startsWith match when prefixOnly is true.
  path: string;
  prefixOnly?: boolean;
  feature?: "registrar";
  handler: StaticRouteHandler;
}

interface CapturingRoute {
  method: "GET" | "POST";
  // Regex pattern with a single capture group. The capture is passed to handler.
  path: RegExp;
  feature?: "registrar";
  handler: CapturingRouteHandler;
}

type Route = StaticRoute | CapturingRoute;

// Factory helpers keep the route table compact while preserving per-handler
// parameter inference (without them the union-typed ROUTES literal degrades
// `req` and `ctx` to `any`).
function staticRoute(
  method: StaticRoute["method"],
  path: string,
  handler: StaticRouteHandler,
  options: { prefixOnly?: boolean; feature?: StaticRoute["feature"] } = {},
): StaticRoute {
  return {
    method,
    path,
    prefixOnly: options.prefixOnly,
    feature: options.feature,
    handler,
  };
}

function regexRoute(
  method: CapturingRoute["method"],
  path: RegExp,
  handler: CapturingRouteHandler,
  options: { feature?: CapturingRoute["feature"] } = {},
): CapturingRoute {
  return { method, path, feature: options.feature, handler };
}

function jsonError(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Module-level route table. Keeps the per-request handler small (one loop) and
// keeps both createDaemonFetchHandler and serve out of max-lines/cognitive-
// complexity territory.
const ROUTES: Route[] = [
  // observations + task drafts
  staticRoute("POST", "/observations", (req, ctx) => observationsRoute(req, ctx.services)),
  staticRoute("GET", "/task-drafts/pending", (req, ctx) =>
    taskDraftsPendingRoute(req, ctx.services),
  ),
  staticRoute("GET", "/task-drafts/pending-escalations", (req, ctx) =>
    taskDraftsPendingEscalationsRoute(req, ctx.services),
  ),
  // recall + memory
  staticRoute("POST", "/recall", (req, ctx) => recallRoute(req, ctx.services)),
  staticRoute("POST", "/memory/search", (req, ctx) => memorySearchRoute(req, ctx.services)),
  staticRoute("POST", "/memory/verify", (req, ctx) => memoryVerifyRoute(req, ctx.services)),
  staticRoute("POST", "/memory-verify/authorize", (req, ctx) =>
    memoryVerifyAuthorizeRoute(req, ctx.services),
  ),
  staticRoute("POST", "/memory/write", (req, ctx) => memoryWriteT2Route(req, ctx.services)),
  staticRoute("POST", "/memory/session-extract", (req, ctx) =>
    memorySessionExtractRoute(req, ctx.services),
  ),
  regexRoute("GET", /^\/memory\/.+\/verification_events$/, (req, ctx) =>
    memoryVerificationEventsRoute(req, ctx.services),
  ),
  staticRoute("POST", "/memory/timeline", (req, ctx) => memoryTimelineRoute(req, ctx.services)),
  staticRoute("POST", "/memory/get", (req, ctx) => memoryGetRoute(req, ctx.services)),
  staticRoute("POST", "/memory/corpus/build", (req, ctx) =>
    memoryCorpusBuildRoute(req, ctx.services),
  ),
  staticRoute("POST", "/memory/corpus/query", (req, ctx) =>
    memoryCorpusQueryRoute(req, ctx.services),
  ),
  staticRoute("POST", "/memory/corpus/list", (req, ctx) =>
    memoryCorpusListRoute(req, ctx.services),
  ),
  staticRoute("POST", "/memory/efficacy/recent", (req, ctx) =>
    memoryEfficacyRecentRoute(req, ctx.services),
  ),
  staticRoute("POST", "/memory/efficacy/rebuild", (req, ctx) =>
    memoryEfficacyRebuildRoute(req, ctx.services),
  ),
  staticRoute("GET", "/memory/efficacy/jobs", (req, ctx) =>
    memoryEfficacyJobsRoute(req, ctx.services),
  ),
  staticRoute(
    "GET",
    "/memory/efficacy/job/",
    (req, ctx) => memoryEfficacyJobRoute(req, ctx.services),
    { prefixOnly: true },
  ),
  staticRoute("GET", "/memory/status", (req, ctx) => memoryStatusRoute(req, ctx.services)),
  // usage + routing
  staticRoute("GET", "/usage/recent", (req, ctx) => usageRecentRoute(req, ctx.services)),
  staticRoute("GET", "/usage/quota_status", (req, ctx) => usageQuotaStatusRoute(req, ctx.services)),
  staticRoute("GET", "/usage/subscription_pressure", (req, ctx) =>
    usageSubscriptionPressureRoute(req, ctx.services),
  ),
  staticRoute("GET", "/routing/bias", (req, ctx) => routingBiasListRoute(req, ctx.services)),
  staticRoute("POST", "/routing/bias", (req, ctx) => routingBiasSetRoute(req, ctx.services)),
  staticRoute("POST", "/routing/bias/clear", (req, ctx) =>
    routingBiasClearRoute(req, ctx.services),
  ),
  // agents
  staticRoute("POST", "/agents/performance/reconciler", (req, ctx) =>
    agentsPerformanceReconcilerRoute(req, ctx.services),
  ),
  staticRoute("POST", "/agents/performance/dispatch", (req, ctx) =>
    agentsPerformanceDispatchRoute(req, ctx.services),
  ),
  staticRoute("POST", "/agents/performance/operator", (req, ctx) =>
    agentsPerformanceOperatorRoute(req, ctx.services),
  ),
  staticRoute("POST", "/agents/performance/import-markdown", (req, ctx) =>
    agentsPerformanceImportMarkdownRoute(req, ctx.services),
  ),
  staticRoute("GET", "/agents/performance/markdown", (req, ctx) =>
    agentsPerformanceMarkdownRoute(req, ctx.services),
  ),
  staticRoute("GET", "/agents/rank", (req, ctx) => agentsRankRoute(req, ctx.services)),
  staticRoute("GET", "/agents/fleet_latency", (req, ctx) =>
    agentsFleetLatencyRoute(req, ctx.services),
  ),
  staticRoute("GET", "/agents/recommend", (req, ctx) => agentsRecommendRoute(req, ctx.services)),
  staticRoute("GET", "/agents/route_for", (req, ctx) => agentsRouteForRoute(req, ctx.services)),
  // metrics
  staticRoute("GET", "/metrics", (_req, ctx) => metricsRoute(ctx.services)),
  // handoffs (top-level + lanes)
  staticRoute("POST", "/handoffs", (req, ctx) => handoffsCreateRoute(req, ctx.services)),
  staticRoute("POST", "/lanes/open", (req, ctx) => lanesOpenRoute(req, ctx.services)),
  staticRoute("POST", "/lanes/close", (req, ctx) => lanesCloseRoute(req, ctx.services)),
  staticRoute("GET", "/lanes/recent", (req, ctx) => lanesRecentRoute(req, ctx.services)),
  staticRoute("GET", "/quality/status", (req, ctx) => qualityStatusRoute(req, ctx.services)),
  // dreaming
  staticRoute("GET", "/dreaming/pending-actions", (req, ctx) =>
    dreamingPendingActionsRoute(req, ctx.services),
  ),
  staticRoute("GET", "/dreaming/health", (req, ctx) => dreamingHealthRoute(req, ctx.services)),
  staticRoute("POST", "/dreaming/revert", (req, ctx) => dreamingRevertRoute(req, ctx.services)),
  staticRoute("POST", "/dreaming/apply", (req, ctx) => dreamingApplyRoute(req, ctx.services)),
  // curator
  staticRoute("GET", "/curator/patterns", (req, ctx) =>
    curatorPatternsListRoute(req, ctx.services),
  ),
  staticRoute("POST", "/curator/patterns", (req, ctx) =>
    curatorPatternsAddRoute(req, ctx.services),
  ),
  regexRoute("POST", /^\/curator\/patterns\/([^/]+)\/approve$/, (req, ctx, id) =>
    curatorPatternsApproveRoute(req, ctx.services, id),
  ),
  regexRoute("POST", /^\/curator\/patterns\/([^/]+)\/disable$/, (req, ctx, id) =>
    curatorPatternsDisableRoute(req, ctx.services, id),
  ),
  // long-lived
  staticRoute("GET", "/long-lived", (req, ctx) => longLivedListRoute(req, ctx.services)),
  staticRoute("GET", "/long-lived/federation-health", (req, ctx) =>
    longLivedFederationHealthRoute(req, ctx.services),
  ),
  regexRoute("GET", /^\/long-lived\/agents\/([^/]+)\/federation-tools$/, (req, ctx, id) =>
    longLivedFederationToolsRoute(req, ctx.services, id),
  ),
  staticRoute("POST", "/long-lived/mcp/call", (req, ctx) =>
    longLivedMcpCallRoute(req, ctx.services),
  ),
  staticRoute("POST", "/long-lived/reconcile-orphans", (req, ctx) =>
    longLivedReconcileOrphansRoute(req, ctx.services),
  ),
  regexRoute("POST", /^\/long-lived\/pending-actions\/([^/]+)\/approve$/, (req, ctx, id) =>
    longLivedApproveActionRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/long-lived\/pending-actions\/([^/]+)\/reject$/, (req, ctx, id) =>
    longLivedRejectActionRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/long-lived\/([^/]+)\/pause$/, (req, ctx, id) =>
    longLivedPauseRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/long-lived\/([^/]+)\/resume$/, (req, ctx, id) =>
    longLivedResumeRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/long-lived\/([^/]+)\/retire$/, (req, ctx, id) =>
    longLivedRetireRoute(req, id, ctx.services),
  ),
  regexRoute("GET", /^\/long-lived\/([^/]+)\/state$/, (req, ctx, id) =>
    longLivedStateGetRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/long-lived\/([^/]+)\/state$/, (req, ctx, id) =>
    longLivedStateSetRoute(req, id, ctx.services),
  ),
  regexRoute("GET", /^\/long-lived\/([^/]+)\/pending-actions$/, (req, ctx, id) =>
    longLivedPendingActionsRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/long-lived\/([^/]+)\/inject-goal$/, (req, ctx, id) =>
    longLivedInjectGoalRoute(req, id, ctx.services),
  ),
  regexRoute("GET", /^\/long-lived\/([^/]+)\/audit$/, (req, ctx, id) =>
    longLivedAuditRoute(req, id, ctx.services),
  ),
  regexRoute("GET", /^\/long-lived\/([^/]+)\/ticks$/, (req, ctx, id) =>
    longLivedTicksRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/long-lived\/([^/]+)\/tick$/, (req, ctx, id) =>
    longLivedTickRoute(req, id, ctx.services),
  ),
  regexRoute("GET", /^\/long-lived\/([^/]+)\/stream$/, (req, ctx, id) =>
    longLivedStreamRoute(req, id, ctx.services),
  ),
  regexRoute("GET", /^\/long-lived\/([^/]+)$/, (req, ctx, id) =>
    longLivedGetRoute(req, id, ctx.services),
  ),
  // maestro
  regexRoute("GET", /^\/maestro\/sessions\/([^/]+)$/, (req, ctx, id) =>
    maestroSessionGetRoute(req, id, ctx.services),
  ),
  staticRoute("POST", "/maestro/sessions", (req, ctx) =>
    maestroSessionStartRoute(req, ctx.services),
  ),
  staticRoute("POST", "/maestro/sessions/adhoc", (req, ctx) =>
    maestroSessionStartAdhocRoute(req, ctx.services),
  ),
  staticRoute("GET", "/maestro/capabilities", (req, ctx) =>
    maestroCapabilitiesRoute(req, ctx.services),
  ),
  // tasks
  staticRoute("POST", "/tasks", (req, ctx) =>
    tasksFileRoute(req, ctx.taskWriter, ctx.services, ctx.ghTaskSyncService),
  ),
  staticRoute("GET", "/tasks/events", (req, ctx) =>
    tasksEventsRoute(req, ctx.services, ctx.taskEvents),
  ),
  staticRoute("GET", "/tasks", (req, ctx) => tasksListRoute(req, ctx.taskWriter)),
  staticRoute("POST", "/tasks/lease", (req, ctx) =>
    tasksLeaseRoute(req, ctx.taskWriter, ctx.ghTaskSyncService),
  ),
  // conversation stream
  regexRoute("GET", /^\/conversations\/([^/]+)\/stream$/, (req, ctx, id) =>
    conversationStreamRoute(req, id, ctx.services),
  ),
  // handoff events + worker control
  staticRoute("GET", "/handoffs/events", (req, ctx) => handoffsEventsRoute(req, ctx.services)),
  staticRoute("GET", "/worker/control", (req, ctx) => workerControlRoute(req, ctx.services)),
  staticRoute("POST", "/worker/register", (req, ctx) =>
    workerRegisterRoute(req, ctx.workerTokenStore),
  ),
  staticRoute("POST", "/worker/heartbeat", (req, ctx) => workerHeartbeatRoute(req, ctx.services)),
  staticRoute("POST", "/worker/reconcile-orphans", (req, ctx) => {
    if (!ctx.orphanHandoffRecovery) return jsonError("recovery_service_unavailable", 503);
    return workerReconcileOrphansRoute(req, ctx.services, ctx.orphanHandoffRecovery);
  }),
  staticRoute("POST", "/worker/probe-ack", (req, ctx) => {
    if (!ctx.workerHealthProbe) return jsonError("worker_health_probe_unavailable", 503);
    return workerProbeAckRoute(req, { ...ctx.services, workerHealthProbe: ctx.workerHealthProbe });
  }),
  // dispatch
  staticRoute("POST", "/dispatch/events", (req, ctx) => dispatchEventsPostRoute(req, ctx.services)),
  staticRoute("GET", "/dispatch/audit", (req, ctx) => dispatchAuditRoute(req, ctx.services)),
  staticRoute("GET", "/dispatch/events/stream", (req, ctx) =>
    dispatchEventsStreamRoute(req, ctx.services),
  ),
  staticRoute("GET", "/dispatch/events", (req, ctx) => dispatchEventsGetRoute(req, ctx.services)),
  staticRoute("POST", "/dispatch/land", (req, ctx) => dispatchLandRoute(req, ctx.services)),
  staticRoute("POST", "/dispatch/refine", (req, ctx) => ctx.dispatchRefineHandler(req)),
  regexRoute("GET", /^\/dispatch\/land\/([^/]+)$/, (req, ctx, id) =>
    dispatchLandTaskRoute(req, ctx.services, id),
  ),
  // shell
  staticRoute("POST", "/shell/run", (req, ctx) => shellRunRoute(req, ctx.services)),
  staticRoute("POST", "/shell/close", (req, ctx) => shellCloseRoute(req, ctx.services)),
  staticRoute("GET", "/shell/list", (req, ctx) => shellListRoute(req, ctx.services)),
  // workflows
  staticRoute("GET", "/workflows/list", (req, ctx) => workflowsListRoute(req, ctx.services)),
  staticRoute("POST", "/workflows/run", (req, ctx) => workflowsRunRoute(req, ctx.services)),
  staticRoute("POST", "/workflows/status", (req, ctx) => workflowsStatusRoute(req, ctx.services)),
  staticRoute("POST", "/workflows/wait", (req, ctx) => workflowsWaitRoute(req, ctx.services)),
  staticRoute("POST", "/workflows/trigger", (req, ctx) => workflowsTriggerRoute(req, ctx.services)),
  staticRoute("GET", "/workflows/history", (req, ctx) => workflowsHistoryRoute(req, ctx.services)),
  staticRoute("POST", "/workflows/suggest", (req, ctx) => workflowsSuggestRoute(req, ctx.services)),
  // workspace / worktrees
  staticRoute("GET", "/workspace", (req, ctx) => workspaceRoute(req, ctx.services)),
  staticRoute("GET", "/worktrees", (req, ctx) => worktreesListRoute(req, ctx.services)),
  regexRoute("GET", /^\/worktrees\/([^/]+)$/, (req, ctx, id) =>
    worktreesInspectRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/worktrees\/([^/]+)\/cleanup$/, (req, ctx, id) =>
    worktreesCleanupRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/worktrees\/([^/]+)\/glob$/, (req, ctx, id) =>
    worktreesGlobRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/worktrees\/([^/]+)\/grep$/, (req, ctx, id) =>
    worktreesGrepRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/worktrees\/([^/]+)\/read$/, (req, ctx, id) =>
    worktreesReadRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/worktrees\/([^/]+)\/write$/, (req, ctx, id) =>
    worktreesWriteRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/worktrees\/([^/]+)\/edit$/, (req, ctx, id) =>
    worktreesEditRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/worktrees\/([^/]+)\/exec$/, (req, ctx, id) =>
    worktreesExecRoute(req, id, ctx.services),
  ),
  // handoff list/get/lifecycle
  staticRoute("GET", "/handoffs", (req, ctx) => handoffsListPendingRoute(req, ctx.daemonServices)),
  staticRoute("GET", "/handoffs/latest", (req, ctx) => handoffsLatestRoute(req, ctx.services)),
  staticRoute("GET", "/handoffs/pending", (req, ctx) =>
    handoffsListPendingRoute(req, ctx.daemonServices),
  ),
  regexRoute("POST", /^\/handoffs\/([^/]+)\/approve$/, (req, ctx, id) =>
    handoffsApproveRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/handoffs\/([^/]+)\/claim$/, (req, ctx, id) =>
    handoffsClaimRoute(req, id, ctx.daemonServices),
  ),
  regexRoute("POST", /^\/handoffs\/([^/]+)\/branch$/, (req, ctx, id) =>
    handoffsRecordBranchRoute(req, id, ctx.daemonServices),
  ),
  regexRoute("GET", /^\/handoffs\/([^/]+)\/status$/, (req, ctx, id) =>
    handoffsStatusRoute(req, id, ctx.services),
  ),
  regexRoute("GET", /^\/handoffs\/([^/]+)$/, (req, ctx, id) =>
    handoffsGetRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/handoffs\/([^/]+)\/progress$/, (req, ctx, id) =>
    handoffsProgressRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/handoffs\/([^/]+)\/complete$/, (req, ctx, id) =>
    handoffsCompleteRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/handoffs\/([^/]+)\/fail$/, (req, ctx, id) =>
    handoffsFailRoute(req, id, ctx.services),
  ),
  // tasks lifecycle
  regexRoute("POST", /^\/tasks\/([^/]+)\/cancel$/, (req, ctx, id) =>
    tasksCancelRoute(req, id, ctx.taskWriter, ctx.ghTaskSyncService),
  ),
  regexRoute("POST", /^\/tasks\/([^/]+)\/link-gh$/, (req, ctx, id) =>
    tasksLinkGhRoute(req, id, ctx.taskWriter, ctx.ghTaskSyncService),
  ),
  // Keep GH task subroutes kebab-case for consistency with /link-gh and /unlink-gh.
  regexRoute("POST", /^\/tasks\/([^/]+)\/comment-gh$/, (req, ctx, id) =>
    tasksCommentGhRoute(req, id, ctx.ghTaskSyncService),
  ),
  regexRoute("POST", /^\/tasks\/([^/]+)\/comment_gh$/, (req, ctx, id) =>
    tasksCommentGhRoute(req, id, ctx.ghTaskSyncService),
  ),
  regexRoute("POST", /^\/tasks\/([^/]+)\/unlink-gh$/, (req, ctx, id) =>
    tasksUnlinkGhRoute(req, id, ctx.taskWriter),
  ),
  staticRoute("POST", "/tasks/sync-gh-now", (req, ctx) =>
    tasksSyncGhNowRoute(req, ctx.ghTaskSyncService),
  ),
  regexRoute("POST", /^\/tasks\/([^/]+)\/heartbeat$/, (req, ctx, id) =>
    tasksHeartbeatRoute(req, id, ctx.taskWriter),
  ),
  regexRoute("POST", /^\/tasks\/([^/]+)\/complete$/, (req, ctx, id) =>
    tasksCompleteRoute(req, id, ctx.taskWriter, ctx.ghTaskSyncService),
  ),
  regexRoute("POST", /^\/tasks\/([^/]+)\/fail$/, (req, ctx, id) =>
    tasksFailRoute(req, id, ctx.taskWriter, ctx.ghTaskSyncService),
  ),
  regexRoute("GET", /^\/tasks\/([^/]+)$/, (req, ctx, id) => tasksGetRoute(req, id, ctx.taskWriter)),
  // permissions + mcp-events
  staticRoute("POST", "/permissions", (req, ctx) => permissionsCreateRoute(req, ctx.services)),
  staticRoute("POST", "/mcp-events/publish", (req) => mcpEventsPublishRoute(req)),
  staticRoute("GET", "/permissions", (req, ctx) => permissionsListRoute(req, ctx.services)),
  staticRoute("GET", "/permissions/events", (req, ctx) =>
    permissionsEventsRoute(req, ctx.services),
  ),
  regexRoute("GET", /^\/permissions\/([^/]+)$/, (req, ctx, id) =>
    permissionsGetRoute(req, id, ctx.services),
  ),
  regexRoute("POST", /^\/permissions\/([^/]+)\/decide$/, (req, ctx, id) =>
    permissionsDecideRoute(req, id, ctx.services),
  ),
  // sessions
  staticRoute("POST", "/sessions/end", (req, ctx) => sessionEndRoute(req, ctx.services)),
  staticRoute("POST", "/sessions/touch", (req, ctx) => sessionsTouchRoute(req, ctx.services)),
  staticRoute("GET", "/session/current", (req, ctx) => sessionCurrentRoute(req, ctx.services)),
  // chains
  staticRoute("POST", "/chains/start", (req, ctx) => chainsStartRoute(req, ctx.services)),
  staticRoute("GET", "/chains", (req, ctx) => chainsListRoute(req, ctx.services)),
  staticRoute("POST", "/agentchat/reload", (req, ctx) =>
    reloadConfigRoute(req, ctx.daemonServices),
  ),
  // reconciler
  staticRoute("POST", "/reconciler/sweep-orphan-prs", (req, ctx) =>
    reconcilerSweepOrphanPrsRoute(req, ctx.services),
  ),
  staticRoute("GET", "/reconciler/verdicts", (req, ctx) =>
    reconcilerVerdictsRoute(req, ctx.services),
  ),
  // chains history/messages/responses/agents + conversation cancel
  staticRoute("GET", "/chains/history", (req, ctx) => chainsHistoryRoute(req, ctx.services)),
  staticRoute("GET", "/chains/messages", (req, ctx) => chainsMessagesRoute(req, ctx.services)),
  regexRoute("POST", /^\/chains\/([^/]+)\/messages$/, (req, ctx, id) =>
    chainSendMessageRoute(req, decodeURIComponent(id), ctx.services),
  ),
  staticRoute("GET", "/chains/responses", (req, ctx) => chainsResponsesRoute(req, ctx.services)),
  staticRoute("GET", "/chains/agents", (req, ctx) => chainsListAgentsRoute(req, ctx.services)),
  regexRoute("POST", /^\/conversations\/([^/]+)\/cancel$/, (req, ctx, id) =>
    conversationsCancelRoute(req, id, ctx.services),
  ),
  // plans
  staticRoute("POST", "/plans", (req, ctx) => plansRegisterRoute(req, ctx.services)),
  staticRoute("GET", "/plans", (req, ctx) => plansListRoute(req, ctx.services)),
  regexRoute("POST", /^\/plans\/([^/]+)\/cancel$/, (req, ctx, id) =>
    plansCancelRoute(req, id, ctx.services, ctx.taskWriter),
  ),
  regexRoute("GET", /^\/plans\/([^/]+)$/, (req, ctx, id) => plansGetRoute(req, id, ctx.services)),
  // registrar
  staticRoute("POST", "/registrar", (req, ctx) => registrarCreateRoute(req, ctx.services), {
    feature: "registrar",
  }),
  staticRoute("GET", "/registrar", (req, ctx) => registrarListRoute(req, ctx.services), {
    feature: "registrar",
  }),
  regexRoute(
    "POST",
    /^\/registrar\/([^/]+)\/events$/,
    (req, ctx, id) => registrarAppendRoute(req, decodeURIComponent(id), ctx.services),
    { feature: "registrar" },
  ),
  regexRoute(
    "GET",
    /^\/registrar\/([^/]+)\/events$/,
    (req, ctx, id) => registrarListEventsRoute(req, decodeURIComponent(id), ctx.services),
    { feature: "registrar" },
  ),
  regexRoute(
    "GET",
    /^\/registrar\/([^/]+)$/,
    (req, ctx, id) => registrarGetRoute(req, decodeURIComponent(id), ctx.services),
    { feature: "registrar" },
  ),
];

function isStaticRoute(route: Route): route is StaticRoute {
  return typeof route.path === "string";
}

function matchesStaticPath(route: StaticRoute, pathname: string): boolean {
  return route.prefixOnly ? pathname.startsWith(route.path) : pathname === route.path;
}

function matchesCapturePath(route: CapturingRoute, pathname: string): string | undefined {
  return route.path.exec(pathname)?.[1];
}

async function dispatchRoute(
  req: Request,
  url: URL,
  ctx: RouteCtx,
  routes: readonly Route[],
): Promise<Response | undefined> {
  for (const route of routes) {
    if (route.method !== req.method) continue;
    if (isStaticRoute(route)) {
      if (matchesStaticPath(route, url.pathname)) return await route.handler(req, ctx);
      continue;
    }
    const id = matchesCapturePath(route, url.pathname);
    if (id !== undefined) return await route.handler(req, ctx, id);
  }
  return undefined;
}

// eslint-disable-next-line max-lines-per-function -- Preserve daemon request dispatch while grandfathering its pre-existing size.
export function createDaemonFetchHandler(opts: {
  services: Services;
  token: string;
  taskEvents?: TaskEventBus;
  taskWriter?: TaskWriter;
  ghTaskSyncService?: GhTaskSyncService;
  ghClient?: GhClient;
  allowRemote?: boolean;
  orphanHandoffRecovery?: OrphanHandoffRecoveryService;
  workerHealthProbe?: WorkerHealthProbe;
  lagSampler?: LagSampler;
  llmFetchFn?: typeof fetch;
  resolveLlmKeychain?: ResolveKeychainSecret;
}): (req: Request) => Promise<Response> {
  const daemonServices = opts.services as DaemonServices;
  // Evaluated once at handler construction; changing PENUMBRA_REGISTRAR requires restart, and only the exact string "0" disables it.
  const routes =
    process.env.PENUMBRA_REGISTRAR === "0"
      ? ROUTES.filter((route) => route.feature !== "registrar")
      : ROUTES;
  const workerTokenStore = new WorkerTokenStore(opts.services.db);
  const auth = createBearerAuth({ token: opts.token, workerTokenStore });
  const originHostGuard = createOriginHostGuard({
    allowRemote:
      opts.allowRemote ??
      (process.env.PENUMBRA_ALLOW_REMOTE === "1" || process.env.NODE_ENV === "test"),
  });
  const taskEvents = opts.taskEvents ?? new TaskEventBus();
  const taskWriter =
    opts.taskWriter ??
    new TaskWriter(opts.services.db, {
      now: (): number => opts.services.clock().getTime(),
      cooldowns: opts.services.taskCooldowns?.get(),
      bus: taskEvents,
      resolveAgent: (name: string): AgentDescriptor | undefined => {
        const cfg = opts.services.agentchatConfig;
        return cfg
          ? getAgentDescriptor(name, cfg as Parameters<typeof getAgentDescriptor>[1])
          : undefined;
      },
    });
  const ghTaskSyncService =
    opts.ghTaskSyncService ??
    createGhTaskSyncSingleFlight(
      createDefaultGhTaskSyncService(opts.services, taskWriter, opts.ghClient),
      opts.services.log,
    );
  startTaskLedgerCapture({ services: opts.services, taskEvents, taskWriter });
  const dispatchRefineHandler = ((): ReturnType<typeof makeDispatchRefineRoute> => {
    const cfg = resolveJudgeConfig(process.env, { extraModelEnv: ["PENUMBRA_REFINER_MODEL"] });
    const candidates = resolveJudgeRoleCandidates(
      opts.services.agentchatConfig,
      process.env.PENUMBRA_REFINER_ROLE ?? "refiner",
      cfg,
    );
    const [primaryCandidate, ...fallbackCandidates] = candidates;
    if (!primaryCandidate) throw new Error("dispatch-refine has no configured LLM candidate");
    // The refiner may use a reasoning model (e.g. lfm2) that emits a long
    // chain-of-thought before the answer, so it needs a larger ceiling than the
    // fast classification judge's 30s default. Configurable via
    // PENUMBRA_REFINER_TIMEOUT_MS; very large inputs can still legitimately
    // exceed it and surface as refiner_upstream_failed.
    const refinerTimeoutMs = Number(process.env.PENUMBRA_REFINER_TIMEOUT_MS) || 90_000;
    safeLogInfo(
      opts.services,
      {
        component: "dispatch-refine",
        baseUrl: primaryCandidate.baseUrl,
        model: primaryCandidate.model,
        timeoutMs: refinerTimeoutMs,
        usedDefaultBaseUrl: cfg.usedDefaultBaseUrl,
        usedDefaultModel: cfg.usedDefaultModel,
      },
      "dispatch-refine: judge endpoint resolved",
    );
    const chat = createJudgeChat({
      baseUrl: primaryCandidate.baseUrl,
      timeoutMs: refinerTimeoutMs,
      provider: primaryCandidate.provider,
      auth: primaryCandidate.auth,
      candidateName: primaryCandidate.name,
      fallbackCandidates,
      activeBiases: () => readRoutingBiases(opts.services.db),
      fetchFn: opts.llmFetchFn,
      resolveKeychain: opts.resolveLlmKeychain,
      onOutcome: (outcome) => {
        recordJudgeOutcome(opts.services.db, "dispatch.refiner", outcome);
      },
    });
    return makeDispatchRefineRoute({ chat, model: primaryCandidate.model });
  })();
  const ctx: RouteCtx = {
    services: opts.services,
    daemonServices,
    taskWriter,
    taskEvents,
    ghTaskSyncService,
    workerTokenStore,
    dispatchRefineHandler,
    orphanHandoffRecovery: opts.orphanHandoffRecovery,
    workerHealthProbe: opts.workerHealthProbe,
    lagSampler: opts.lagSampler,
  };
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin");
    // Genuine loopback preflights answer before the host guard: they carry no body or state and their origin is already allowlisted.
    const preflight = corsPreflightResponse(req, origin);
    if (preflight) return preflight;
    const response = await (async (): Promise<Response> => {
      const originDenied = originHostGuard(req, origin);
      if (originDenied) return originDenied;
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return healthRoute({
          sampler: opts.lagSampler,
          db: opts.services.db,
          now: opts.services.clock,
          llmRoleFloors: daemonServices.llmRoleFloorEvaluation,
        });
      }
      // OTLP routes: localhost-only via daemon's 127.0.0.1 bind, no bearer auth.
      if (req.method === "POST" && url.pathname === "/v1/logs")
        return await otlpLogsRoute(req, opts.services);
      if (req.method === "POST" && url.pathname === "/v1/metrics")
        return await otlpMetricsRoute(req, opts.services);
      if (req.method === "POST" && url.pathname === "/v1/traces")
        return await otlpTracesRoute(req, opts.services);
      const denied = auth(req);
      if (denied) return denied;
      const dispatched = await dispatchRoute(req, url, ctx, routes);
      return dispatched ?? new Response("not found", { status: 404 });
    })();
    return withCorsResponseHeaders(origin, response);
  };
}

interface CronTickWorker {
  tick(): Promise<void>;
}

interface CronWorkers {
  rollup: CronTickWorker;
  promotion: CronTickWorker;
  retention: CronTickWorker;
  dispatchEventsRetention: CronTickWorker;
  sweeper: CronTickWorker;
  watchdog: CronTickWorker;
  localSeatHealth?: CronTickWorker;
}

function registerCronWorkers(services: Services, workers: CronWorkers): void {
  const { settings, supervisor } = services;
  supervisor.register({
    name: "t1-rollup",
    intervalMs: settings.t1RollupIntervalSec * 1000,
    tick: (): Promise<void> => workers.rollup.tick(),
  });
  supervisor.register({
    name: "t2-promotion",
    intervalMs: Math.max(settings.t1RollupIntervalSec, 300) * 1000,
    tick: (): Promise<void> => workers.promotion.tick(),
  });
  supervisor.register({
    name: "t0-retention",
    intervalMs: 3600 * 1000,
    tick: (): Promise<void> => workers.retention.tick(),
  });
  supervisor.register({
    name: "dispatch-events-retention",
    intervalMs: 3600 * 1000,
    tick: (): Promise<void> => workers.dispatchEventsRetention.tick(),
  });
  supervisor.register({
    name: "handoff-sweeper",
    intervalMs: 60 * 1000,
    tick: (): Promise<void> => workers.sweeper.tick(),
  });
  supervisor.register({
    name: "worker-watchdog",
    intervalMs: 15_000,
    tick: (): Promise<void> => workers.watchdog.tick(),
  });
  const localSeatHealth = workers.localSeatHealth;
  if (localSeatHealth) {
    supervisor.register({
      name: "local-seat-health",
      intervalMs: 20_000,
      tick: (): Promise<void> => localSeatHealth.tick(),
    });
  }
  void supervisor.startAll();
}

interface ReactorStack {
  planRuntimeSweeper: ReturnType<typeof createPlanRuntimeSweeper>;
  planRuntimeUnsub: () => void;
  orchestrateReactor: ReturnType<typeof createOrchestrateReactor>;
  orchestrateDeferralSweeper: ReturnType<typeof createOrchestrateDeferralSweeper>;
  longLivedReactor: ReturnType<typeof createLongLivedReactor>;
}

interface ReactorStackDeps {
  services: Services;
  taskWriter: TaskWriter;
  taskEvents: TaskEventBus;
  maestroSessions: MaestroSessionWriter;
  resolveAgent: (name: string) => AgentDescriptor | undefined;
}

function buildReactorStack(deps: ReactorStackDeps): ReactorStack {
  // Plan-runtime registers BEFORE orchestrate-reactor so task.completed events
  // flip plan-task status before any sibling spawn fires.
  const planRuntimeSweeper = createPlanRuntimeSweeper({
    db: deps.services.db,
    plans: deps.services.planWriter,
    taskWriter: deps.taskWriter,
    worktreeManager: deps.services.worktreeManager,
    log: deps.services.log,
    now: (): number => deps.services.clock().getTime(),
  });
  planRuntimeSweeper.start();
  const planRuntimeUnsub = planRuntimeSweeper.subscribe(deps.taskEvents);
  const orchestrateReactor = createOrchestrateReactor({
    db: deps.services.db,
    bus: deps.taskEvents,
    sessions: deps.maestroSessions,
    taskWriter: deps.taskWriter,
    chainCancel: (chain_handoff_id: string): Promise<void> =>
      cancelChainByHandoffId(deps.services, chain_handoff_id),
    chainStart: (request: ChainStartRequest) => chainStartForOrchestrate(deps.services, request),
    resolveAgent: deps.resolveAgent,
    defaults: {
      wall_clock_ms: 1_800_000,
      cost_cents: 200,
      sub_dispatches: 10,
    },
    now: (): number => deps.services.clock().getTime(),
  });
  const orchestrateDeferralSweeper = createOrchestrateDeferralSweeper({
    db: deps.services.db,
    bus: deps.taskEvents,
    now: (): number => deps.services.clock().getTime(),
  });
  const mcpPool = createMcpPool({ log: deps.services.log.child({ component: "mcp-pool" }) });
  const { executeTool, takeSnapshot } = buildActionGateCallbacks({
    db: deps.services.db,
    mcpPool,
    log: deps.services.log,
  });
  const actionGate = createActionGate({
    db: deps.services.db,
    executeTool,
    takeSnapshot,
    now: (): number => deps.services.clock().getTime(),
  });
  const longLivedReactor = createLongLivedReactor({
    db: deps.services.db,
    bus: getMcpEventBus(),
    now: (): number => deps.services.clock().getTime(),
    mcpPool,
    dispatchEventLog: deps.services.dispatchEventLog,
    notificationOutbox: deps.services.notificationOutbox,
    loadAgentchatYaml: () => {
      const cfg = deps.services.agentchatConfig;
      return Promise.resolve({ agents: Array.isArray(cfg?.agents) ? cfg.agents : [] });
    },
    isChainActive: (chain_id: string): boolean => {
      const active = deps.services.db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n
         FROM handoffs
         WHERE conversation_id = ?
           AND status IN ('approved', 'dispatched')`,
        )
        .get(chain_id);
      return (active?.n ?? 0) > 0;
    },
    spawn: (req): Promise<{ chain_id: string }> => spawnLongLivedTick(deps.services, req),
  });
  deps.services.mcpPool = mcpPool;
  deps.services.actionGate = actionGate;
  deps.services.longLivedReactor = longLivedReactor;
  return {
    planRuntimeSweeper,
    planRuntimeUnsub,
    orchestrateReactor,
    orchestrateDeferralSweeper,
    longLivedReactor,
  };
}

interface HttpServerHandle {
  server: ReturnType<typeof Bun.serve>;
  port: number;
}

function startHttpServer(args: {
  opts: ServeOpts;
  taskEvents: TaskEventBus;
  taskWriter: TaskWriter;
  ghTaskSyncService: GhTaskSyncService;
  workerHealthProbe: WorkerHealthProbe;
  lagSampler: LagSampler;
  extraWorkerSupervisor: ExtraWorkerSupervisor;
  workerProbeEnabled: boolean;
}): HttpServerHandle {
  const {
    opts,
    taskEvents,
    taskWriter,
    ghTaskSyncService,
    workerHealthProbe,
    lagSampler,
    extraWorkerSupervisor,
    workerProbeEnabled,
  } = args;
  const fetchHandler = createDaemonFetchHandler({
    services: opts.services,
    token: opts.token,
    taskEvents,
    taskWriter,
    ghTaskSyncService,
    workerHealthProbe,
    lagSampler,
  });
  const hostname = firstNonEmpty(
    opts.hostname?.trim(),
    process.env.PENUMBRA_DAEMON_HOST?.trim(),
    "127.0.0.1",
  );
  const server = Bun.serve({
    hostname,
    port: opts.port,
    fetch: fetchHandler,
    idleTimeout: 255, // 4m15s to accommodate long-running SSE without tokens
  });
  const port = server.port ?? opts.port;
  opts.services.log.info({ port }, "daemon started");
  // Positive boot-time record of the ranking cutover in effect — backdating
  // the env override silently re-loosens the success predicate, so the
  // resolved value must always be visible in the boot log.
  opts.services.log.info(
    { gate_outcome_cutover: resolveGateOutcomeCutoverIso() },
    "gate-outcome cutover resolved",
  );
  extraWorkerSupervisor.start().catch((err: unknown) => {
    opts.services.log.error(
      {
        event: "extra_worker_supervisor_start_failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "extra worker supervisor failed to start",
    );
  });
  if (workerProbeEnabled) {
    workerHealthProbe.start();
  }
  return { server, port };
}

interface TaskCollaborators {
  taskCooldowns: TaskCooldowns;
  taskEvents: TaskEventBus;
  resolveAgent: (name: string) => AgentDescriptor | undefined;
  maestroSessions: MaestroSessionWriter;
  taskWriter: TaskWriter;
  ghTaskSyncService: GhTaskSyncService;
  ghTaskSyncSweeper: ReturnType<typeof createGhTaskSyncSweeper>;
  workerManager: NonNullable<Services["workerManager"]>;
  boundsTracker: ReturnType<typeof createBoundsTracker>;
}

function setupTaskCollaborators(opts: ServeOpts): TaskCollaborators {
  const taskCooldowns = new TaskCooldowns();
  opts.services.taskCooldowns = taskCooldowns;
  const taskEvents = new TaskEventBus();
  const resolveAgent = (name: string): AgentDescriptor | undefined => {
    const cfg = opts.services.agentchatConfig;
    return cfg
      ? getAgentDescriptor(name, cfg as Parameters<typeof getAgentDescriptor>[1])
      : undefined;
  };
  const maestroSessions = new MaestroSessionWriter({
    db: opts.services.db,
    now: (): number => opts.services.clock().getTime(),
  });
  const taskWriter = new TaskWriter(opts.services.db, {
    now: (): number => opts.services.clock().getTime(),
    cooldowns: taskCooldowns.get(),
    bus: taskEvents,
    resolveAgent,
    maestroSessions,
    onOrchestrateCancel: (chain_handoff_id: string): void => {
      void cancelChainByHandoffId(opts.services, chain_handoff_id).catch((err: unknown) => {
        console.warn("[task.cancel] chainCancel failed", err);
      });
    },
  });
  const ghTaskSyncService = createGhTaskSyncSingleFlight(
    createDefaultGhTaskSyncService(opts.services, taskWriter),
    opts.services.log,
  );
  const ghTaskSyncSweeper = createGhTaskSyncSweeper({
    service: ghTaskSyncService,
    fullReconcileIntervalMs: opts.services.settings.ghTaskSyncFullReconcileIntervalMs,
    log: opts.services.log,
  });
  ghTaskSyncSweeper.start();
  opts.services.maestroSessions = maestroSessions;
  opts.services.taskWriter = taskWriter;
  const workerManager =
    opts.services.workerManager ??
    createHttpWorkerManager({
      logWarn: (message: string): void => {
        console.warn(message);
      },
    });
  const acpInjector = createAcpInjector({ workerManager: workerManager as AcpWorkerManagerLike });
  const boundsCallbacks = createBoundsCallbacks({
    db: opts.services.db,
    services: opts.services,
    taskWriter,
    sessions: maestroSessions,
    injector: acpInjector,
    bus: taskEvents,
    chainCancel: (chain_handoff_id: string): Promise<void> =>
      cancelChainByHandoffId(opts.services, chain_handoff_id),
    now: (): number => opts.services.clock().getTime(),
  });
  const boundsTracker = createBoundsTracker({
    db: opts.services.db,
    sessions: maestroSessions,
    intervalMs: 5_000,
    warnThreshold: 0.8,
    now: (): number => opts.services.clock().getTime(),
    onSoftWarn: boundsCallbacks.onSoftWarn,
    onPressureSoftWarn: boundsCallbacks.onPressureSoftWarn,
    onHardKill: boundsCallbacks.onHardKill,
    evaluatePressure: boundsCallbacks.evaluatePressure,
  });
  return {
    taskCooldowns,
    taskEvents,
    resolveAgent,
    maestroSessions,
    taskWriter,
    ghTaskSyncService,
    ghTaskSyncSweeper,
    workerManager,
    boundsTracker,
  };
}

interface BootDiagnostics {
  lagSampler: LagSampler;
  watchdog: WatchdogService;
}

function setupBootDiagnostics(opts: ServeOpts, daemonServices: DaemonServices): BootDiagnostics {
  const envNonNegMs = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const lagSampler = new LagSampler(
    opts.services.log,
    envNonNegMs("PENUMBRA_EVENT_LOOP_LAG_THRESHOLD_MS", 500),
    envNonNegMs("PENUMBRA_EVENT_LOOP_LAG_INTERVAL_MS", 2000),
  );
  lagSampler.start();
  const watchdog = new WatchdogService(opts.services);
  daemonServices.watchdog = watchdog;
  installGlobalCrashHandlers({
    log: opts.services.log,
    flush: (): void => {
      opts.services.log.flush();
    },
  });
  // Sweep any dream_cycles left in 'running' state from a previous daemon crash
  // before any cron scheduler can start a new cycle.
  runStartupZombieSweep(opts.services.db);
  const embeddingVersionWarning = checkEmbeddingModelVersion(
    process.env.PENUMBRA_EMBEDDING_MODEL_VERSION ?? "v1",
    readStoredEmbeddingModelVersion(opts.services.db),
  );
  if (embeddingVersionWarning) {
    opts.services.log.warn({ event: "embedding_model_version_mismatch" }, embeddingVersionWarning);
  }
  return { lagSampler, watchdog };
}

interface CronWorkerSet {
  rollup: ReturnType<typeof createRollupWorker>;
  promotion: ReturnType<typeof createT2PromotionWorker>;
  retention: ReturnType<typeof createT0RetentionWorker>;
  dispatchEventsRetention: ReturnType<typeof createDispatchEventsRetentionWorker>;
  sweeper: ReturnType<typeof createHandoffSweeperWorker>;
}

function createCronWorkerSet(opts: ServeOpts, dreamConfig: DreamConfig): CronWorkerSet {
  return {
    rollup: createRollupWorker({
      services: opts.services,
      idleMinutes: opts.services.settings.t1SessionIdleMinutes,
    }),
    promotion: createT2PromotionWorker({
      services: opts.services,
      delayHours: opts.services.settings.t2PromotionDelayHours,
      minEvents: dreamConfig.t2PromotionMinEvents ?? 5,
    }),
    retention: createT0RetentionWorker({
      services: opts.services,
      retentionDays: opts.services.settings.t0RetentionDays,
    }),
    dispatchEventsRetention: createDispatchEventsRetentionWorker({
      services: opts.services,
      retentionDays: opts.services.settings.dispatchEventsRetentionDays,
    }),
    sweeper: createHandoffSweeperWorker({
      services: opts.services,
    }),
  };
}

function createEfficacyJobRunnerEntry(
  opts: ServeOpts,
): ReturnType<typeof createMemoryEfficacyJobRunner> {
  const cfg = resolveJudgeConfig();
  const candidates = resolveJudgeRoleCandidates(
    opts.services.agentchatConfig,
    process.env.PENUMBRA_JUDGE_ROLE ?? "memory-refiner",
    cfg,
  );
  const [primaryCandidate, ...fallbackCandidates] = candidates;
  if (!primaryCandidate) throw new Error("memory-efficacy has no configured LLM candidate");
  opts.services.log.info(
    {
      component: "memory-efficacy",
      baseUrl: primaryCandidate.baseUrl,
      model: primaryCandidate.model,
      usedDefaultBaseUrl: cfg.usedDefaultBaseUrl,
      usedDefaultModel: cfg.usedDefaultModel,
    },
    "memory-efficacy: judge endpoint resolved",
  );
  const judgeChat = createJudgeChat({
    baseUrl: primaryCandidate.baseUrl,
    provider: primaryCandidate.provider,
    auth: primaryCandidate.auth,
    candidateName: primaryCandidate.name,
    fallbackCandidates,
    activeBiases: () => readRoutingBiases(opts.services.db),
    onOutcome: (outcome) => {
      recordJudgeOutcome(opts.services.db, "memory.efficacy_judge", outcome);
    },
  });
  return createMemoryEfficacyJobRunner({
    db: opts.services.db,
    services: opts.services,
    judgeChat,
    model: primaryCandidate.model,
    intervalMs: 5000,
    pressureGuardEnabled:
      process.env.PENUMBRA_MEMORY_EFFICACY_PRESSURE_GUARD === "1" ||
      process.env.PENUMBRA_MEMORY_EFFICACY_PRESSURE_GUARD === "true",
    log: opts.services.log,
  });
}

function resolveJudgeRoleCandidates(
  agentchatConfig: CoreServices["agentchatConfig"],
  roleTag: string,
  legacy: ResolvedJudgeConfig,
): LlmCandidate[] {
  return resolveRoleLlmCandidates({
    roleTag,
    agentchatConfig: agentchatConfig ?? {},
    fallbackCandidates: [
      {
        name: legacy.model,
        baseUrl: legacy.baseUrl,
        model: legacy.model,
        provider: legacy.provider,
        auth: legacy.token ? { source: "bearer", token: legacy.token } : { source: "none" },
      },
    ],
  });
}

function recordJudgeOutcome(
  db: CoreServices["db"],
  subsystem: string,
  outcome: {
    ok: boolean;
    candidate: LlmServingCandidate;
    reason?: string;
    status?: number;
  },
): void {
  recordSubsystemOutcome(db, {
    subsystem,
    tier: outcome.candidate.tier,
    ok: outcome.ok,
    seat: outcome.candidate.name,
    model: outcome.candidate.model,
    host: new URL(outcome.candidate.baseUrl).hostname,
    reason: outcome.reason,
    status: outcome.status,
  });
}

interface ExtraWorkerSetup {
  probeRef: { current: WorkerHealthProbe | undefined };
  extraWorkerSupervisor: ExtraWorkerSupervisor;
}

function setupExtraWorkerSupervisor(
  opts: ServeOpts,
  daemonServices: DaemonServices,
): ExtraWorkerSetup {
  // probeRef bridges a forward reference: `rebuildWorkerAuthz` is invoked
  // before the WorkerHealthProbe instance exists, then again later from the
  // ExtraWorkerSupervisor's onConfigChange after the probe has been wired in.
  const probeRef: { current: WorkerHealthProbe | undefined } = { current: undefined };
  const extraWorkers = loadExtraWorkersConfig({
    projectRegistry: opts.services.projectRegistry,
    log: opts.services.log,
  });
  const rebuildWorkerAuthz = (extras: ExtraWorkerConfig[]): void => {
    const workerAuthz = new Map<
      string,
      { project_id?: string; isolation: ExtraWorkerConfig["isolation"] }
    >();
    for (const extra of extras) {
      workerAuthz.set(extra.id, { project_id: extra.project_id, isolation: extra.isolation });
    }
    daemonServices.workerAuthz = workerAuthz;
    probeRef.current?.prune(extras.map((extra) => extra.id));
  };
  rebuildWorkerAuthz(extraWorkers.extras);
  const extraWorkerSupervisor = new ExtraWorkerSupervisor({
    extras: extraWorkers.extras,
    storageRoot: opts.services.storageRoot,
    log: opts.services.log,
    onConfigChange: rebuildWorkerAuthz,
  });
  daemonServices.extraWorkerSupervisor = extraWorkerSupervisor;
  for (const extra of extraWorkers.extras) {
    opts.services.log.info(
      {
        event: "extra_worker_configured",
        worker_id: extra.id,
        project_id: extra.project_id,
        concurrency: extra.concurrency,
        isolation: extra.isolation,
      },
      "extra worker configured",
    );
  }
  return { probeRef, extraWorkerSupervisor };
}

interface RecoverySweepers {
  stopPermissionSweeper: () => void;
  stopOrphanLanesSweeper: () => void;
  stopWorktreeGcSweeper: () => void;
  stopStaleWorkerTokensSweeper: () => void;
  stopStaleHandoffSweeper: () => void;
  orphanHandoffRecovery: OrphanHandoffRecoveryService;
  stopOrphanHandoffRecovery: () => void;
  workerHealthProbe: WorkerHealthProbe;
  workerProbeEnabled: boolean;
  stopWorkerProbe: () => void;
  stopEfficacyJobReclaimSweeper: () => void;
  stopReconcilerSweeper: () => void;
  prOrphanSweeper: ReturnType<typeof installPrOrphanSweeper>;
}

function setupRecoverySweepers(args: {
  opts: ServeOpts;
  daemonServices: DaemonServices;
  extraWorkerSupervisor: ExtraWorkerSupervisor;
  probeRef: { current: WorkerHealthProbe | undefined };
  watchdog: WatchdogService;
}): RecoverySweepers {
  const { opts, daemonServices, extraWorkerSupervisor, probeRef, watchdog } = args;
  const stopPermissionSweeper = startPermissionTtlSweeper(opts.services);
  const stopOrphanLanesSweeper = startOrphanLanesSweeper(opts.services);
  const stopWorktreeGcSweeper = startWorktreeGcSweeper({
    services: opts.services,
    log: opts.services.log,
  });
  const stopStaleWorkerTokensSweeper = startStaleWorkerTokensSweeper({
    db: opts.services.db,
    log: opts.services.log,
  });
  const workerHeartbeatStaleMs = Number(process.env.PENUMBRA_WORKER_HEARTBEAT_STALE_MS) || 90000;
  const staleSweepLivenessCheckEnabled = process.env.PENUMBRA_STALE_SWEEP_LIVENESS_CHECK === "1";
  const staleSweepMaxAliveGraceMs =
    Number(process.env.PENUMBRA_STALE_SWEEP_MAX_ALIVE_GRACE_MS) || 30 * 60_000;
  const stopStaleHandoffSweeper = startStaleHandoffSweeper({
    services: opts.services,
    resolveStaleAfterMs,
    livenessCheckEnabled: staleSweepLivenessCheckEnabled,
    maxAliveGraceMs: staleSweepMaxAliveGraceMs,
    isWorkerHeartbeatFresh: (workerId: string): boolean => {
      if (!watchdog.hasWorker(workerId)) return false;
      const staleWorkers = new Set(watchdog.getStaleWorkers(workerHeartbeatStaleMs));
      return !staleWorkers.has(workerId);
    },
  });
  const strictModeEnv = process.env.PENUMBRA_ORPHAN_HANDOFF_STRICT_MODE;
  if (strictModeEnv !== undefined) {
    opts.services.log.warn(
      { env: "PENUMBRA_ORPHAN_HANDOFF_STRICT_MODE" },
      "deprecated orphan recovery env var set; use PENUMBRA_ORPHAN_HANDOFF_FAIL_FAST instead",
    );
  }
  const orphanHandoffRecovery = new OrphanHandoffRecoveryService(opts.services, {
    staleMs: workerHeartbeatStaleMs,
    intervalMs:
      process.env.PENUMBRA_ORPHAN_HANDOFF_RECOVERY_INTERVAL_MS !== undefined
        ? Number(process.env.PENUMBRA_ORPHAN_HANDOFF_RECOVERY_INTERVAL_MS)
        : 15000,
    batchSize: Number(process.env.PENUMBRA_ORPHAN_HANDOFF_RECOVERY_BATCH) || 100,
    failFastMode: process.env.PENUMBRA_ORPHAN_HANDOFF_FAIL_FAST === "1" || strictModeEnv === "1",
  });
  daemonServices.orphanHandoffRecovery = orphanHandoffRecovery;
  const stopOrphanHandoffRecovery = orphanHandoffRecovery.start().stop;
  const workerHealthProbe = new WorkerHealthProbe({
    services: daemonServices,
    intervalMs: Number(process.env.PENUMBRA_WORKER_PROBE_INTERVAL_MS ?? "15000") || 15_000,
    missThreshold: Number(process.env.PENUMBRA_WORKER_PROBE_MISS_THRESHOLD ?? "3") || 3,
    controller: createWorkerHealthController({
      extraWorkerSupervisor,
      dispatchEventLog: daemonServices.dispatchEventLog,
      orphanHandoffRecovery,
    }),
    log: opts.services.log,
  });
  probeRef.current = workerHealthProbe;
  daemonServices.workerHealthProbe = workerHealthProbe;
  const workerProbeEnabled = process.env.PENUMBRA_WORKER_PROBE_ENABLED !== "0";
  const stopWorkerProbe = (): void => {
    workerHealthProbe.stop();
  };
  const stopEfficacyJobReclaimSweeper = startEfficacyJobReclaimSweeper({
    services: opts.services,
  });
  // PR-orphan closing is owned by installPrOrphanSweeper; reconciler sweeps stay dry-run for visibility.
  const reconcilerDryRun = true;
  const stopReconcilerSweeper = startReconcilerSweeper({
    services: opts.services,
    dryRun: reconcilerDryRun,
    log: opts.services.log,
  });
  const prOrphanSweeper = installPrOrphanSweeper({
    db: opts.services.db,
    intervalMs: opts.services.settings.prOrphanSweeperIntervalMs,
    dryRun: opts.services.settings.prOrphanSweeperDryRun,
    applyDefault: true,
    t0Writer: opts.services.t0Writer,
    uuid: opts.services.uuid,
    clock: opts.services.clock,
    machineId: opts.services.machineId,
    log: opts.services.log,
  });
  return {
    stopPermissionSweeper,
    stopOrphanLanesSweeper,
    stopWorktreeGcSweeper,
    stopStaleWorkerTokensSweeper,
    stopStaleHandoffSweeper,
    orphanHandoffRecovery,
    stopOrphanHandoffRecovery,
    workerHealthProbe,
    workerProbeEnabled,
    stopWorkerProbe,
    stopEfficacyJobReclaimSweeper,
    stopReconcilerSweeper,
    prOrphanSweeper,
  };
}

interface LateSweepers {
  taskLeaseSweeper: ReturnType<typeof createTaskLeaseSweeper>;
  stopNotificationSweeper: () => void;
  stopGateQualityDigestSweeper: () => void;
  stopWorkflowSweeper: () => void;
  stopAaSnapshotRefreshSweeper: () => void;
  stopProviderDriftSweeper: () => void;
}

const execFile = promisify(execFileCb);

function buildProviderDriftStop(args: {
  env: ReturnType<typeof getConfig>["env"];
  clock: () => Date;
  log: {
    info?: (obj: Record<string, unknown>, msg: string) => void;
    warn?: (obj: Record<string, unknown>, msg: string) => void;
  };
}): () => void {
  const { env, clock, log } = args;
  if (env.PENUMBRA_PROVIDER_DRIFT_SWEEP_DISABLED === true) {
    return (): void => undefined;
  }
  // serve.ts lives at packages/daemon/src/, so two levels up reaches
  // packages/ and the CLI entry resolves to packages/cli/bin/penumbra.ts.
  const cliEntry =
    (env.PENUMBRA_PROVIDER_DRIFT_CLI_ENTRY as string | undefined) ??
    fileURLToPath(new URL("../../cli/bin/penumbra.ts", import.meta.url));
  if (!existsSync(cliEntry)) {
    log.warn?.({ cliEntry }, "provider-drift: CLI entry not found; sweeper idle");
    return (): void => undefined;
  }
  return startProviderDriftSweeper(
    {
      runDiscoveryDryRun: async () => {
        try {
          const { stdout, stderr } = await execFile(
            process.execPath,
            [cliEntry, ...PROVIDER_DRIFT_DRY_RUN_ARGV],
            { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: process.env },
          );
          return { exitCode: 0, stdout: stdout.split("\n"), stderr: stderr.split("\n") };
        } catch (err) {
          const execErr = err as { code?: number | string; stdout?: string; stderr?: string };
          return {
            exitCode: typeof execErr.code === "number" ? execErr.code : 1,
            stdout: (execErr.stdout ?? "").split("\n"),
            stderr: (execErr.stderr ?? "").split("\n"),
          };
        }
      },
      now: clock,
      log,
    },
    (env.PENUMBRA_PROVIDER_DRIFT_SWEEP_INTERVAL_MS as number | undefined) ??
      DEFAULT_PROVIDER_DRIFT_SWEEP_INTERVAL_MS,
  );
}

function startLateSweepers(args: {
  opts: ServeOpts;
  taskCooldowns: TaskCooldowns;
  taskEvents: TaskEventBus;
}): LateSweepers {
  const { opts, taskCooldowns, taskEvents } = args;
  const taskLeaseSweeper = createTaskLeaseSweeper({
    db: opts.services.db,
    now: (): number => opts.services.clock().getTime(),
    cooldowns: taskCooldowns,
    bus: taskEvents,
  });
  taskLeaseSweeper.start();
  const refiningStuckRecoverySweeper = createRefiningStuckRecoverySweeper({
    db: opts.services.db,
    reader: opts.services.taskDraftReader,
    t0Writer: opts.services.t0Writer,
    now: (): number => opts.services.clock().getTime(),
    uuid: (): string => opts.services.uuid(),
    machineId: opts.services.machineId,
    log: opts.services.log,
  });
  refiningStuckRecoverySweeper.start();
  const stopNotificationSweeper = startNotificationSweeper({
    db: opts.services.db,
    outbox: opts.services.notificationOutbox,
    getEnv: (key: string): string | undefined => process.env[key],
    now: (): number => opts.services.clock().getTime(),
    log: opts.services.log,
  });
  const stopGateQualityDigestSweeper = startGateQualityDigestSweeper({
    services: opts.services,
    outDir: process.env.PENUMBRA_GATE_QUALITY_DIGEST_DIR ?? join(homedir(), ".penumbra"),
    now: (): Date => opts.services.clock(),
    getEnv: (key: string): string | undefined => process.env[key],
    log: opts.services.log,
  });
  const aaSnapshotRefreshConfig = getConfig().env;
  const aaSnapshotRefreshDisabled =
    aaSnapshotRefreshConfig.PENUMBRA_AA_SNAPSHOT_REFRESH_DISABLED === true;
  const stopAaSnapshotRefreshSweeper = aaSnapshotRefreshDisabled
    ? (): void => undefined
    : startAaSnapshotRefreshSweeper(
        {
          get aaSnapshotStore() {
            return opts.services.aaSnapshotStore;
          },
          now: (): Date => opts.services.clock(),
          log: opts.services.log,
        },
        (aaSnapshotRefreshConfig.PENUMBRA_AA_SNAPSHOT_REFRESH_INTERVAL_MS as number | undefined) ??
          DEFAULT_AA_SNAPSHOT_REFRESH_INTERVAL_MS,
      );
  const stopProviderDriftSweeper = buildProviderDriftStop({
    env: aaSnapshotRefreshConfig,
    clock: (): Date => opts.services.clock(),
    log: opts.services.log,
  });
  const stopWorkflowSweeper = ((): (() => void) => {
    const reg = opts.services.workflowRegistry;
    if (!reg) {
      return (): void => {
        /* no workflow registry; nothing to stop */
      };
    }
    const cwd = process.cwd();
    let project = "unknown";
    try {
      const resolved = resolveProjectId({ cwd });
      if (resolved.project_id) project = resolved.project_id;
    } catch {
      /* project resolution best-effort; fall back to "unknown" */
    }
    return startWorkflowTriggerSweeper({
      registry: reg,
      computeMetrics: (now: () => Date) => computeStateMetrics({ db: opts.services.db, now }),
      runWorkflow: async (name: string): Promise<void> => {
        await runWorkflowTriggerEntry(opts, name, cwd, project);
      },
      log: opts.services.log,
    });
  })();
  return {
    taskLeaseSweeper,
    stopNotificationSweeper,
    stopGateQualityDigestSweeper,
    stopWorkflowSweeper,
    stopAaSnapshotRefreshSweeper,
    stopProviderDriftSweeper,
  };
}

interface StopHandlerDeps {
  services: Services;
  daemonServices: DaemonServices;
  onStop: (() => void) | undefined;
  lagSampler: LagSampler;
  startupState: { stopped: boolean };
  efficacyJobRunner: { stop(): void };
  server: { stop(closeActiveConnections: boolean): Promise<void> };
  recovery: RecoverySweepers;
  lateSweepers: LateSweepers;
  collaborators: TaskCollaborators;
  reactorStack: ReactorStack;
  dreamingStops: DreamingStops;
}

function buildStopHandler(deps: StopHandlerDeps): () => Promise<void> {
  return async (): Promise<void> => {
    deps.lagSampler.stop();
    deps.startupState.stopped = true;
    await deps.daemonServices.extraWorkerSupervisor?.stop();
    deps.recovery.stopWorkerProbe();
    deps.services.supervisor.stopAll();
    deps.efficacyJobRunner.stop();
    void deps.server.stop(true);
    deps.recovery.stopPermissionSweeper();
    deps.recovery.stopOrphanLanesSweeper();
    deps.recovery.stopWorktreeGcSweeper();
    deps.recovery.stopStaleWorkerTokensSweeper();
    deps.recovery.stopStaleHandoffSweeper();
    deps.recovery.stopOrphanHandoffRecovery();
    deps.recovery.stopEfficacyJobReclaimSweeper();
    deps.recovery.stopReconcilerSweeper();
    deps.recovery.prOrphanSweeper.stop();
    deps.lateSweepers.taskLeaseSweeper.stop();
    deps.collaborators.boundsTracker.stop();
    deps.reactorStack.planRuntimeUnsub();
    deps.reactorStack.planRuntimeSweeper.stop();
    deps.reactorStack.orchestrateDeferralSweeper.stop();
    deps.reactorStack.orchestrateReactor.stop();
    await deps.reactorStack.longLivedReactor.shutdown();
    deps.lateSweepers.stopWorkflowSweeper();
    deps.lateSweepers.stopNotificationSweeper();
    deps.lateSweepers.stopGateQualityDigestSweeper();
    deps.lateSweepers.stopAaSnapshotRefreshSweeper();
    deps.lateSweepers.stopProviderDriftSweeper();
    deps.collaborators.ghTaskSyncSweeper.stop();
    deps.dreamingStops.stopDreaming?.();
    deps.dreamingStops.stopDigest?.();
    deps.dreamingStops.stopEventTrigger?.();
    try {
      deps.onStop?.();
    } catch {
      /* already closed or noop */
    }
  };
}

interface StartupSequenceDeps {
  services: Services;
  maestroSessions: MaestroSessionWriter;
  taskWriter: TaskWriter;
  taskEvents: TaskEventBus;
  workerManager: { lookupSession(chain_handoff_id: string): unknown };
  longLivedReactor: { reload(): Promise<void> };
  boundsTracker: { start(): void };
  orchestrateReactor: { start(): void };
  orchestrateDeferralSweeper: { start(): void };
  startupState: { stopped: boolean };
}

async function runStartupSequence(deps: StartupSequenceDeps): Promise<void> {
  try {
    await runRestartResume({
      db: deps.services.db,
      sessions: deps.maestroSessions,
      taskWriter: deps.taskWriter,
      isChainAlive: async (chain_handoff_id: string): Promise<boolean> => {
        try {
          return Boolean(await deps.workerManager.lookupSession(chain_handoff_id));
        } catch {
          return false;
        }
      },
      // Hook reserved for future in-memory tracker state restore.
      attachToTracker: (): void => {
        /* no-op placeholder */
      },
      bus: deps.taskEvents,
      now: (): number => deps.services.clock().getTime(),
    });
  } catch (error) {
    console.warn("[serve] restart-resume failed; continuing startup", error);
  }
  try {
    await deps.longLivedReactor.reload();
  } catch (error) {
    console.warn("[serve] long-lived reactor reload failed; continuing startup", error);
  }
  if (!deps.startupState.stopped) {
    deps.boundsTracker.start();
    deps.orchestrateReactor.start();
    deps.orchestrateDeferralSweeper.start();
  }
}

async function chainStartForOrchestrate(
  services: Services,
  request: ChainStartRequest,
): Promise<{ handoff_id: string; conversation_id: string }> {
  const response = await chainStartInternal(request, services, {
    applyMaestroBudgetGate: false,
  });
  if (!response.ok) {
    const bodyText = await response.text();
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = null;
    }
    const error = new Error(
      `chain_start failed (${String(response.status)}): ${bodyText}`,
    ) as Error & {
      status?: number;
      bodyText?: string;
      body?: Record<string, unknown> | null;
    };
    error.status = response.status;
    error.bodyText = bodyText;
    error.body = body;
    throw error;
  }
  const data = (await response.json()) as { handoff_id?: unknown; conversation_id?: unknown };
  if (typeof data.handoff_id !== "string" || typeof data.conversation_id !== "string") {
    throw new Error("chain_start returned malformed response");
  }
  return { handoff_id: data.handoff_id, conversation_id: data.conversation_id };
}

async function spawnLongLivedTick(
  services: Services,
  req: { agent_id: string; tick_id: string },
): Promise<{ chain_id: string }> {
  const agentRow = services.db
    .query<{ agent_name: string; project_id: string | null }, [string]>(
      `SELECT id AS agent_name, project_id
         FROM long_lived_agents
         WHERE id = ?
         LIMIT 1`,
    )
    .get(req.agent_id);
  if (!agentRow) {
    throw new Error(`unknown long-lived agent: ${req.agent_id}`);
  }
  const response = await chainStartInternal(
    {
      initial_agent: agentRow.agent_name,
      message: `long-lived tick ${req.tick_id}`,
      dispatch_kind: "long_lived_tick",
      long_lived_agent_id: req.agent_id,
      long_lived_tick_id: req.tick_id,
      project_id: agentRow.project_id ?? "penumbra",
      use_worktree: false,
      max_hops: 1,
    },
    services,
    { applyMaestroBudgetGate: false },
  );
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`long-lived chain_start failed (${String(response.status)}): ${bodyText}`);
  }
  const body = (await response.json()) as { conversation_id?: unknown };
  if (typeof body.conversation_id !== "string") {
    throw new Error("long-lived chain_start returned malformed response");
  }
  return { chain_id: body.conversation_id };
}

interface DreamingStops {
  stopDreaming: (() => void) | undefined;
  stopDigest: (() => void) | undefined;
  stopEventTrigger: (() => void) | undefined;
}

function setupDreamingCron(services: Services, runtimeDreamConfig: DreamConfig): DreamingStops {
  const stops: DreamingStops = {
    stopDreaming: undefined,
    stopDigest: undefined,
    stopEventTrigger: undefined,
  };
  if (!runtimeDreamConfig.enabled) return stops;
  stops.stopDreaming = startDreamingCron({
    db: services.db,
    config: runtimeDreamConfig,
    log: services.log,
    cycleDeps: buildDreamCycleDeps(services, services.db, runtimeDreamConfig),
  });
  stops.stopDigest = startDailyDigestCron({
    db: services.db,
    outDir: process.env.PENUMBRA_DREAM_DIGEST_DIR ?? join(homedir(), ".penumbra"),
    log: services.log,
  });
  if (!runtimeDreamConfig.eventTriggerEnabled) return stops;
  const checkIdle = async (): Promise<void> => {
    try {
      const lastActivity = services.db
        .prepare(
          "SELECT MAX(ts) as ts FROM dispatch_events WHERE kind IN ('dispatch.end','long_lived.tick.end')",
        )
        .get() as { ts: string | null };
      const lastTs = lastActivity.ts ? Date.parse(lastActivity.ts) : 0;
      if (Date.now() - lastTs >= runtimeDreamConfig.idleMinutes * 60_000) {
        const { dreamingCycleInFlight } = await import("./dreaming/cycle.js");
        const { handleIdleSignal } = await import("./dreaming/event-trigger.js");
        await handleIdleSignal(services.db, runtimeDreamConfig, {
          mutexHeld: dreamingCycleInFlight,
          log: services.log,
          cycleDeps: buildDreamCycleDeps(services, services.db, runtimeDreamConfig),
        });
      }
    } catch (err) {
      services.log.warn({ err: String(err) }, "dreaming: idle trigger failed unexpectedly");
    }
  };
  const timer = setInterval(() => {
    void checkIdle();
  }, 60_000);
  if (typeof timer.unref === "function") timer.unref();
  stops.stopEventTrigger = (): void => {
    clearInterval(timer);
  };
  return stops;
}

export function serve(opts: ServeOpts): DaemonHandle {
  const daemonServices = opts.services as DaemonServices;
  const configDir = resolveAgentChatConfigPath(process.env);
  let taskRouterConfig: TaskRouterConfig;
  try {
    taskRouterConfig = loadTaskRouterConfigFromDir(configDir);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    opts.services.log.error({ err: message }, `${message}; falling back to defaults`);
    taskRouterConfig = TaskRouterConfigSchema.parse({});
  }
  let modelAliasMap: ModelAliasMap;
  try {
    modelAliasMap = loadModelAliasMapFromDir(configDir);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    opts.services.log.error({ err: message }, `${message}; falling back to defaults`);
    modelAliasMap = {};
  }
  daemonServices.taskRouterConfig = taskRouterConfig;
  daemonServices.modelAliasMap = modelAliasMap;
  daemonServices.aaSnapshotStore = createAaSnapshotStore({
    ttlSeconds: taskRouterConfig.snapshot_ttl_seconds,
    now: () => opts.services.clock(),
  });
  const configBundle = getConfig();
  const dreamConfig = buildDreamingConfig(configBundle);
  const dreamRuntime = resolveDreamRuntimeConfig(opts.services.db, configBundle, dreamConfig);
  const runtimeDreamConfig = dreamRuntime.config;
  if (dreamRuntime.autoResumedFromHistory) {
    opts.services.log.warn(
      {
        event: "dreaming_auto_resumed_from_history",
        source: configBundle.sources.PENUMBRA_DREAMING_ENABLED,
      },
      "dreaming: auto-resumed cron because historical cycles exist and PENUMBRA_DREAMING_ENABLED is not explicitly set",
    );
  }
  evaluateStartupLlmRoleFloors(opts, runtimeDreamConfig);
  const { probeRef, extraWorkerSupervisor } = setupExtraWorkerSupervisor(opts, daemonServices);
  // Opt-in local-seat health-gating (default off). When enabled via routing.yaml
  // role_routing.local_seat_health_gate, the daemon probes local openai-compat
  // backends and excludes down/unknown seats from routing. When off, the service
  // is never constructed and routing behaves exactly as before — penumbra needs
  // no local-model server present.
  const localSeatHealthEnabled =
    (opts.services.agentRouting as { role_routing?: { local_seat_health_gate?: boolean } } | null)
      ?.role_routing?.local_seat_health_gate === true;
  const localSeatHealth = localSeatHealthEnabled
    ? createLocalSeatHealthService({
        agents: () => opts.services.agentchatConfig?.agents ?? [],
      })
    : undefined;
  if (localSeatHealth) {
    daemonServices.localSeatHealth = localSeatHealth;
    void localSeatHealth.refresh();
  }

  // Signal ownership stays with CLI/embedding callers; log-only handlers here
  // would suppress the default SIGTERM/SIGINT process termination.
  const { lagSampler, watchdog } = setupBootDiagnostics(opts, daemonServices);
  const cronWorkers = createCronWorkerSet(opts, dreamConfig);
  const { rollup, promotion, retention, dispatchEventsRetention, sweeper } = cronWorkers;
  const efficacyJobRunner = createEfficacyJobRunnerEntry(opts);
  const recovery = setupRecoverySweepers({
    opts,
    daemonServices,
    extraWorkerSupervisor,
    probeRef,
    watchdog,
  });
  const collaborators = setupTaskCollaborators(opts);
  const reactorStack = buildReactorStack({
    services: opts.services,
    taskWriter: collaborators.taskWriter,
    taskEvents: collaborators.taskEvents,
    maestroSessions: collaborators.maestroSessions,
    resolveAgent: collaborators.resolveAgent,
  });
  // Guard: if stop() is called before the async startup completes (common in tests),
  // skip start() calls to prevent intervals firing against a closed DB. The ref
  // shape lets the stop() closure flip the flag without eslint statically
  // proving it's never reassigned at the check site inside the async IIFE.
  const startupState: { stopped: boolean } = { stopped: false };
  void runStartupSequence({
    services: opts.services,
    maestroSessions: collaborators.maestroSessions,
    taskWriter: collaborators.taskWriter,
    taskEvents: collaborators.taskEvents,
    workerManager: collaborators.workerManager,
    longLivedReactor: reactorStack.longLivedReactor,
    boundsTracker: collaborators.boundsTracker,
    orchestrateReactor: reactorStack.orchestrateReactor,
    orchestrateDeferralSweeper: reactorStack.orchestrateDeferralSweeper,
    startupState,
  });
  const lateSweepers = startLateSweepers({
    opts,
    taskCooldowns: collaborators.taskCooldowns,
    taskEvents: collaborators.taskEvents,
  });
  registerCronWorkers(opts.services, { ...cronWorkers, watchdog, localSeatHealth });
  efficacyJobRunner.start();
  const dreamingStops = setupDreamingCron(opts.services, runtimeDreamConfig);
  const { server, port } = startHttpServer({
    opts,
    taskEvents: collaborators.taskEvents,
    taskWriter: collaborators.taskWriter,
    ghTaskSyncService: collaborators.ghTaskSyncService,
    workerHealthProbe: recovery.workerHealthProbe,
    lagSampler,
    extraWorkerSupervisor,
    workerProbeEnabled: recovery.workerProbeEnabled,
  });
  return {
    port,
    stop: buildStopHandler({
      services: opts.services,
      daemonServices,
      onStop: opts.onStop,
      lagSampler,
      startupState,
      efficacyJobRunner,
      server,
      recovery,
      lateSweepers,
      collaborators,
      reactorStack,
      dreamingStops,
    }),
  };
}
