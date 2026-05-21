import { resolveProjectId, type ChainStartRequest, MaestroSessionWriter, createJudgeChat, resolveJudgeConfig, type Watchdog, type Services as CoreServices } from '@penumbra/core';
import type { Services } from '../../core/src/services.js';
import { getAgentDescriptor } from '@penumbra/agentchat';
import { TaskCooldowns, TaskEventBus, TaskWriter, type TaskLeaseRow, type TaskEvent, AgentPerformanceWriter, mapTaskEventToLedger, ledgerWriteToPerformanceRow } from '@penumbra/core';
import { composeRecall, executeWorkflow, computeStateMetrics, type TemplateVarContext } from '@penumbra/workflows';
import { WorkerTokenStore } from '@penumbra/core';
import { workerRegisterRoute } from './routes/worker-register.js';
import { createBearerAuth } from './auth.js';
import { createOriginHostGuard } from './origin-host.js';
import { WatchdogService } from './services/watchdog.js';
import { OrphanHandoffRecoveryService } from './services/orphan-handoff-recovery.js';
import { healthRoute } from './routes/health.js';
import { observationsRoute } from './routes/observations.js';
import { taskDraftsPendingEscalationsRoute, taskDraftsPendingRoute } from './routes/task-drafts.js';
import { recallRoute } from './routes/recall.js';
import {
  memorySearchRoute,
  memoryVerifyRoute,
  memoryVerificationEventsRoute,
  memoryTimelineRoute,
  memoryGetRoute,
  memoryCorpusBuildRoute,
  memoryCorpusQueryRoute,
  memoryCorpusListRoute,
  memoryStatusRoute,
  memoryEfficacyRecentRoute,
  memoryEfficacyRebuildRoute,
  memoryEfficacyJobRoute,
  memoryEfficacyJobsRoute,
} from './routes/memory.js';
import { memoryVerifyAuthorizeRoute } from './routes/memory-verify.js';
import { usageRecentRoute, usageQuotaStatusRoute, usageSubscriptionPressureRoute } from './routes/usage.js';
import {
  agentsPerformanceDispatchRoute,
  agentsPerformanceImportMarkdownRoute,
  agentsPerformanceMarkdownRoute,
  agentsPerformanceOperatorRoute,
  agentsPerformanceReconcilerRoute,
  agentsRankRoute,
  agentsRouteForRoute,
  agentsRecommendRoute,
} from './routes/agents.js';
import { metricsRoute } from './routes/metrics.js';
import { qualityStatusRoute } from './routes/quality.js';
import { sessionEndRoute } from './routes/session-end.js';
import { sessionsTouchRoute, sessionCurrentRoute } from './routes/sessions.js';
import { lanesCloseRoute, lanesOpenRoute, lanesRecentRoute } from './routes/lanes.js';
import {
  handoffsCreateRoute,
  handoffsListPendingRoute,
  handoffsLatestRoute,
  handoffsApproveRoute,
  handoffsClaimRoute,
  handoffsCompleteRoute,
  handoffsFailRoute,
  handoffsGetRoute,
  handoffsStatusRoute,
} from './routes/handoffs.js';
import { handoffsProgressRoute } from './routes/handoffs-progress.js';
import { handoffsEventsRoute } from './routes/handoffs-events.js';
import { conversationStreamRoute } from './routes/conversation-stream.js';
import { conversationsCancelRoute } from './routes/conversations.js';
import { workerControlRoute } from './routes/worker-control.js';
import { workerHeartbeatRoute } from './routes/worker-heartbeat.js';
import { workerReconcileOrphansRoute } from './routes/worker-reconcile-orphans.js';
import { dispatchAuditRoute } from './routes/dispatch-audit.js';
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
  longLivedTickRoute,
  longLivedStateGetRoute,
  longLivedStateSetRoute,
  longLivedStreamRoute,
  longLivedTicksRoute,
} from './routes/long-lived.js';
import { longLivedMcpCallRoute } from './routes/long-lived-mcp.js';
import { longLivedFederationToolsRoute } from './routes/long-lived-federation-tools.js';
import { longLivedFederationHealthRoute } from './routes/long-lived-federation-health.js';
import { dispatchEventsGetRoute, dispatchEventsPostRoute, dispatchEventsStreamRoute } from './routes/dispatch-events.js';
import { mcpEventsPublishRoute } from './routes/mcp-events.js';
import { dispatchLandRoute, dispatchLandTaskRoute } from './routes/dispatch-land.js';
import { makeDispatchRefineRoute } from './routes/dispatch-refine.js';
import { maestroCapabilitiesRoute, maestroSessionGetRoute, maestroSessionStartAdhocRoute, maestroSessionStartRoute } from './routes/maestro.js';
import { worktreesListRoute, worktreesInspectRoute, worktreesCleanupRoute } from './routes/worktrees.js';
import {
  workflowsListRoute,
  workflowsRunRoute,
  workflowsStatusRoute,
  workflowsWaitRoute,
  workflowsTriggerRoute,
  workflowsHistoryRoute,
  workflowsSuggestRoute,
} from './routes/workflows.js';
import { worktreesGlobRoute, worktreesGrepRoute } from './routes/fs.js';
import { reloadConfigRoute } from './routes/reload-config.js';
import { reconcilerSweepOrphanPrsRoute, reconcilerVerdictsRoute } from './routes/reconciler.js';
import { otlpLogsRoute, otlpMetricsRoute, otlpTracesRoute } from './routes/otlp.js';
import { chainStartInternal, chainsStartRoute, chainsHistoryRoute, chainsResponsesRoute, chainsListAgentsRoute, chainsListRoute, chainsMessagesRoute, chainSendMessageRoute } from './routes/chains.js';
import { shellCloseRoute, shellListRoute, shellRunRoute } from './routes/shell.js';
import {
  tasksFileRoute,
  tasksListRoute,
  tasksGetRoute,
  tasksCancelRoute,
  tasksLinkGhRoute,
  tasksCommentGhRoute,
  tasksUnlinkGhRoute,
  tasksSyncGhNowRoute,
  tasksLeaseRoute,
  tasksHeartbeatRoute,
  tasksCompleteRoute,
  tasksFailRoute,
} from './routes/tasks.js';
import {
  plansRegisterRoute,
  plansListRoute,
  plansGetRoute,
  plansCancelRoute,
} from './routes/plans.js';
import { tasksEventsRoute } from './routes/tasks-events.js';
import {
  permissionsCreateRoute,
  permissionsGetRoute,
  permissionsListRoute,
  permissionsDecideRoute,
} from './routes/permissions.js';
import { permissionsEventsRoute } from './routes/permissions-events.js';
import { startPermissionTtlSweeper } from './sweepers/permission-ttl.js';
import { startOrphanLanesSweeper } from './sweepers/orphan-lanes.js';
import { startWorkflowTriggerSweeper } from './sweepers/workflow-trigger.js';
import { startStaleHandoffSweeper } from './sweepers/stale-handoff.js';
import { startStaleWorkerTokensSweeper } from './sweepers/stale-worker-tokens.js';
import { resolveStaleAfterMs } from './sweepers/stale-handoff-thresholds.js';
import { startEfficacyJobReclaimSweeper } from './sweepers/efficacy-job-reclaim.js';
import { startReconcilerSweeper } from './sweepers/reconciler-sweep.js';
import { createTaskLeaseSweeper } from './sweepers/task-leases.js';
import { createRollupWorker } from './workers/t1-rollup.js';
import { createT2PromotionWorker } from './workers/t2-promotion.js';
import { createT0RetentionWorker } from './workers/t0-retention.js';
import { createHandoffSweeperWorker } from './workers/handoff-sweeper.js';
import { createMemoryEfficacyJobRunner } from './workers/memory-efficacy-job-runner.js';
import { createOrchestrateReactor } from './reactors/orchestrate-reactor.js';
import { createLongLivedReactor } from './reactors/long-lived-reactor.js';
import { createMcpPool } from './long-lived/mcp-pool.js';
import { createActionGate } from './long-lived/action-gate.js';
import { buildActionGateCallbacks } from './long-lived/action-gate-callbacks.js';
import { createPlanRuntimeSweeper } from './sweepers/plan-runtime.js';
import { createOrchestrateDeferralSweeper } from './sweepers/orchestrate-deferral.js';
import { installPrOrphanSweeper } from './sweepers/pr-orphan-sweeper.js';
import {
  createDefaultGhTaskSyncService,
  createGhTaskSyncSweeper,
  type GhTaskSyncService,
} from './sweepers/gh-task-sync.js';
import type { GhClient } from './services/gh-client.js';
import { createBoundsTracker } from './maestro/bounds-tracker.js';
import { createAcpInjector, type AcpWorkerManagerLike } from './maestro/acp-injector.js';
import { createHttpWorkerManager } from './maestro/worker-manager-http.js';
import { createBoundsCallbacks } from './maestro/bounds-callbacks.js';
import { runRestartResume } from './maestro/restart-resume.js';
import { getMcpEventBus } from './events/mcp-event-bus.js';

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

type DaemonServices = CoreServices & {
  watchdog?: Watchdog;
  orphanHandoffRecovery?: OrphanHandoffRecoveryService;
};

async function runWorkflowTriggerEntry(opts: ServeOpts, name: string, cwd: string, project: string): Promise<void> {
  const reg = opts.services.workflowRegistry;
  if (!reg) return;
  const entry = (reg.getEntry(name) as { spec: any; fn?: any } | undefined);
  if (!entry) return;
  const start = Date.now();
  const templateCtx: TemplateVarContext = {
    now: () => new Date(),
    project,
    sessionStart: new Date(start).toISOString(),
    tz: process.env.TZ ?? 'UTC',
    cwd,
    repoRoot: cwd,
  };
  const services = opts.services;
  const registry = services.agentRegistry;
  const agentRegistry = registry
    ? { listAgents: () => registry.map((name) => ({ name })) }
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
      sessionId: 'sweeper',
      userId: 'penumbra',
      machineId: process.env.HOSTNAME ?? 'unknown',
    },
    captureKind: 'refresh',
  });
}

function resolveLedgerLeaseRow(
  services: Services,
  event: TaskEvent,
): TaskLeaseRow | undefined {
  if (event.kind === 'released' && event.payload?.reason === 'expired') {
    const leaseId = typeof event.payload.lease_id === 'string' ? event.payload.lease_id : null;
    if (!leaseId) return undefined;
    return services.db
      .query<TaskLeaseRow, [string]>(
        `SELECT id, task_id, agent_id, claimed_at, expires_at, released_at, release_reason, auction_score
         FROM task_leases
         WHERE id = ?
         LIMIT 1`,
      )
      .get(leaseId) ?? undefined;
  }

  if (event.kind === 'completed') {
    return services.db
      .query<TaskLeaseRow, [string]>(
        `SELECT id, task_id, agent_id, claimed_at, expires_at, released_at, release_reason, auction_score
         FROM task_leases
         WHERE task_id = ? AND release_reason = 'completed'
         ORDER BY claimed_at DESC
         LIMIT 1`,
      )
      .get(event.task_id) ?? undefined;
  }

  if (event.kind === 'review_passed' || event.kind === 'review_failed') {
    return services.db
      .query<TaskLeaseRow, [string]>(
        `SELECT id, task_id, agent_id, claimed_at, expires_at, released_at, release_reason, auction_score
         FROM task_leases
         WHERE task_id = ? AND release_reason = 'completed'
         ORDER BY claimed_at DESC
         LIMIT 1`,
      )
      .get(event.task_id) ?? undefined;
  }

  return undefined;
}

function startTaskLedgerCapture(opts: {
  services: Services;
  taskEvents: TaskEventBus;
  taskWriter: TaskWriter;
}): void {
  const project_id = (() => {
    try {
      return resolveProjectId({ cwd: process.cwd() }).project_id ?? null;
    } catch {
      return null;
    }
  })();

  const perfWriter = new AgentPerformanceWriter(opts.services.db);
  const watched = new Set(['completed', 'review_passed', 'review_failed', 'released']);

  const iterator = opts.taskEvents.subscribe((event) => watched.has(event.kind));
  void (async () => {
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
          opts.services.log?.warn?.({
            err: error,
            task_id: event.task_id,
            kind: event.kind,
          }, 'task->ledger write failed');
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
    .query<HandoffConversationRow | null, [string]>(
      'SELECT conversation_id FROM handoffs WHERE handoff_id = ? LIMIT 1',
    )
    .get(chain_handoff_id);
  if (!row?.conversation_id) {
    console.warn(`[bounds-callbacks] cannot cancel chain; handoff not found: ${chain_handoff_id}`);
    return;
  }

  const response = await conversationsCancelRoute(
    new Request(`http://localhost/conversations/${row.conversation_id}/cancel`, { method: 'POST' }),
    row.conversation_id,
    services,
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`conversation cancel failed (${response.status}): ${body}`);
  }
}

export function createDaemonFetchHandler(
  opts: {
    services: Services;
    token: string;
    taskEvents?: TaskEventBus;
    taskWriter?: TaskWriter;
    ghTaskSyncService?: GhTaskSyncService;
    ghClient?: GhClient;
    allowRemote?: boolean;
    orphanHandoffRecovery?: OrphanHandoffRecoveryService;
  },
): (req: Request) => Promise<Response> {
  const workerTokenStore = new WorkerTokenStore(opts.services.db);
  const auth = createBearerAuth({ token: opts.token, workerTokenStore });
  const originHostGuard = createOriginHostGuard({
    allowRemote: opts.allowRemote
      ?? (process.env.PENUMBRA_ALLOW_REMOTE === '1' || process.env.NODE_ENV === 'test'),
  });
  const taskEvents = opts.taskEvents ?? new TaskEventBus();
  const taskWriter = opts.taskWriter ?? new TaskWriter(opts.services.db, {
    now: () => opts.services.clock().getTime(),
    cooldowns: opts.services.taskCooldowns?.get(),
    bus: taskEvents,
    resolveAgent: (name) => {
      const cfg = opts.services.agentchatConfig;
      return cfg ? getAgentDescriptor(name, cfg as Parameters<typeof getAgentDescriptor>[1]) : undefined;
    },
  });
  const ghTaskSyncService = opts.ghTaskSyncService
    ?? createDefaultGhTaskSyncService(opts.services, taskWriter, opts.ghClient);
  startTaskLedgerCapture({ services: opts.services, taskEvents, taskWriter });
  const dispatchRefineHandler = (() => {
    const cfg = resolveJudgeConfig(process.env, { extraModelEnv: ['PENUMBRA_REFINER_MODEL'] });
    (opts.services.log as any)?.info?.(
      {
        component: 'dispatch-refine',
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        usedDefaultBaseUrl: cfg.usedDefaultBaseUrl,
        usedDefaultModel: cfg.usedDefaultModel,
      },
      'dispatch-refine: judge endpoint resolved',
    );
    const chat = createJudgeChat({ baseUrl: cfg.baseUrl, token: cfg.token });
    return makeDispatchRefineRoute({ chat, model: cfg.model });
  })();
  return async (req: Request) => {
    const originDenied = originHostGuard(req);
    if (originDenied) return originDenied;
    const url = new URL(req.url);
    if (url.pathname === '/health') return healthRoute();
    // OTLP routes: localhost-only via daemon's 127.0.0.1 bind, no bearer auth.
    if (req.method === 'POST' && url.pathname === '/v1/logs') return otlpLogsRoute(req, opts.services);
    if (req.method === 'POST' && url.pathname === '/v1/metrics') return otlpMetricsRoute(req, opts.services);
    if (req.method === 'POST' && url.pathname === '/v1/traces') return otlpTracesRoute(req, opts.services);
    const denied = auth(req);
    if (denied) return denied;
    if (req.method === 'POST' && url.pathname === '/observations') {
      return observationsRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/task-drafts/pending') {
      return taskDraftsPendingRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/task-drafts/pending-escalations') {
      return taskDraftsPendingEscalationsRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/recall') {
      return recallRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/memory/search') {
      return memorySearchRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/memory/verify') {
      return memoryVerifyRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/memory-verify/authorize') {
      return memoryVerifyAuthorizeRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/memory/') && url.pathname.endsWith('/verification_events')) {
      return memoryVerificationEventsRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/memory/timeline') {
      return memoryTimelineRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/memory/get') {
      return memoryGetRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/memory/corpus/build') {
      return memoryCorpusBuildRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/memory/corpus/query') {
      return memoryCorpusQueryRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/memory/corpus/list') {
      return memoryCorpusListRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/memory/efficacy/recent') {
      return memoryEfficacyRecentRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/memory/efficacy/rebuild') {
      return memoryEfficacyRebuildRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/memory/efficacy/jobs') {
      return memoryEfficacyJobsRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/memory/efficacy/job/')) {
      return memoryEfficacyJobRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/memory/status') {
      return memoryStatusRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/usage/recent') {
      return usageRecentRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/usage/quota_status') {
      return usageQuotaStatusRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/usage/subscription_pressure') {
      return usageSubscriptionPressureRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/agents/performance/reconciler') {
      return agentsPerformanceReconcilerRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/agents/performance/dispatch') {
      return agentsPerformanceDispatchRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/agents/performance/operator') {
      return agentsPerformanceOperatorRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/agents/performance/import-markdown') {
      return agentsPerformanceImportMarkdownRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/agents/performance/markdown') {
      return agentsPerformanceMarkdownRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/agents/rank') {
      return agentsRankRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/agents/recommend') {
      return agentsRecommendRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/agents/route_for') {
      return agentsRouteForRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/metrics') {
      return metricsRoute(opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/handoffs') {
      return handoffsCreateRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/lanes/open') {
      return lanesOpenRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/lanes/close') {
      return lanesCloseRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/lanes/recent') {
      return lanesRecentRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/quality/status') {
      return qualityStatusRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/long-lived') {
      return longLivedListRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/long-lived/federation-health') {
      return longLivedFederationHealthRoute(req, opts.services);
    }
    const longLivedFederationToolsMatch = url.pathname.match(/^\/long-lived\/agents\/([^/]+)\/federation-tools$/);
    if (req.method === 'GET' && longLivedFederationToolsMatch) {
      return longLivedFederationToolsRoute(req, opts.services, longLivedFederationToolsMatch[1]!);
    }
    if (req.method === 'POST' && url.pathname === '/long-lived/mcp/call') {
      return longLivedMcpCallRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/long-lived/reconcile-orphans') {
      return longLivedReconcileOrphansRoute(req, opts.services);
    }
    const longLivedApproveMatch = url.pathname.match(/^\/long-lived\/pending-actions\/([^/]+)\/approve$/);
    if (req.method === 'POST' && longLivedApproveMatch) {
      return longLivedApproveActionRoute(req, longLivedApproveMatch[1]!, opts.services);
    }
    const longLivedRejectMatch = url.pathname.match(/^\/long-lived\/pending-actions\/([^/]+)\/reject$/);
    if (req.method === 'POST' && longLivedRejectMatch) {
      return longLivedRejectActionRoute(req, longLivedRejectMatch[1]!, opts.services);
    }
    const longLivedIdActionMatch = url.pathname.match(/^\/long-lived\/([^/]+)\/(pause|resume|retire|state|pending-actions|inject-goal|audit|ticks|tick)$/);
    if (longLivedIdActionMatch) {
      const [, id, action] = longLivedIdActionMatch;
      if (action === 'pause' && req.method === 'POST') return longLivedPauseRoute(req, id!, opts.services);
      if (action === 'resume' && req.method === 'POST') return longLivedResumeRoute(req, id!, opts.services);
      if (action === 'retire' && req.method === 'POST') return longLivedRetireRoute(req, id!, opts.services);
      if (action === 'state' && req.method === 'GET') return longLivedStateGetRoute(req, id!, opts.services);
      if (action === 'state' && req.method === 'POST') return longLivedStateSetRoute(req, id!, opts.services);
      if (action === 'pending-actions' && req.method === 'GET') return longLivedPendingActionsRoute(req, id!, opts.services);
      if (action === 'inject-goal' && req.method === 'POST') return longLivedInjectGoalRoute(req, id!, opts.services);
      if (action === 'audit' && req.method === 'GET') return longLivedAuditRoute(req, id!, opts.services);
      if (action === 'ticks' && req.method === 'GET') return longLivedTicksRoute(req, id!, opts.services);
      if (action === 'tick' && req.method === 'POST') return longLivedTickRoute(req, id!, opts.services);
    }
    const longLivedStreamMatch = url.pathname.match(/^\/long-lived\/([^/]+)\/stream$/);
    if (req.method === 'GET' && longLivedStreamMatch) {
      return longLivedStreamRoute(req, longLivedStreamMatch[1]!, opts.services);
    }
    const longLivedMatch = url.pathname.match(/^\/long-lived\/([^/]+)$/);
    if (req.method === 'GET' && longLivedMatch) {
      return longLivedGetRoute(req, longLivedMatch[1]!, opts.services);
    }
    const maestroSessionGetMatch = url.pathname.match(/^\/maestro\/sessions\/([^/]+)$/);
    if (req.method === 'GET' && maestroSessionGetMatch) {
      return maestroSessionGetRoute(req, maestroSessionGetMatch[1]!, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/maestro/sessions') {
      return maestroSessionStartRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/maestro/sessions/adhoc') {
      return maestroSessionStartAdhocRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/maestro/capabilities') {
      return maestroCapabilitiesRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/tasks') {
      return tasksFileRoute(req, taskWriter, opts.services, ghTaskSyncService);
    }
    if (req.method === 'GET' && url.pathname === '/tasks/events') {
      return tasksEventsRoute(req, opts.services, taskEvents);
    }
    if (req.method === 'GET' && url.pathname === '/tasks') {
      return tasksListRoute(req, taskWriter);
    }
    if (req.method === 'POST' && url.pathname === '/tasks/lease') {
      return tasksLeaseRoute(req, taskWriter, ghTaskSyncService);
    }
    const convStreamMatch = url.pathname.match(/^\/conversations\/([^/]+)\/stream$/);
    if (req.method === 'GET' && convStreamMatch) {
      return conversationStreamRoute(req, convStreamMatch[1]!, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/handoffs/events') {
      return handoffsEventsRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/worker/control') {
      return workerControlRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/worker/register') {
      return workerRegisterRoute(req, workerTokenStore);
    }
    if (req.method === 'POST' && url.pathname === '/worker/heartbeat') {
      return workerHeartbeatRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/worker/reconcile-orphans') {
      if (!opts.orphanHandoffRecovery) {
        return new Response(JSON.stringify({ error: { code: 'recovery_service_unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return workerReconcileOrphansRoute(req, opts.services, opts.orphanHandoffRecovery);
    }
    if (req.method === 'POST' && url.pathname === '/dispatch/events') {
      return dispatchEventsPostRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/dispatch/audit') {
      return dispatchAuditRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/dispatch/events/stream') {
      return dispatchEventsStreamRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/dispatch/events') {
      return dispatchEventsGetRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/dispatch/land') {
      return dispatchLandRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/dispatch/refine') {
      return dispatchRefineHandler(req);
    }
    const dispatchLandTaskMatch = url.pathname.match(/^\/dispatch\/land\/([^/]+)$/);
    if (req.method === 'GET' && dispatchLandTaskMatch) {
      return dispatchLandTaskRoute(req, opts.services, dispatchLandTaskMatch[1]!);
    }
    if (req.method === 'POST' && url.pathname === '/shell/run') {
      return shellRunRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/shell/close') {
      return shellCloseRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/shell/list') {
      return shellListRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/workflows/list') {
      return workflowsListRoute(req, opts.services as never);
    }
    if (req.method === 'POST' && url.pathname === '/workflows/run') {
      return workflowsRunRoute(req, opts.services as never);
    }
    if (req.method === 'POST' && url.pathname === '/workflows/status') {
      return workflowsStatusRoute(req, opts.services as never);
    }
    if (req.method === 'POST' && url.pathname === '/workflows/wait') {
      return workflowsWaitRoute(req, opts.services as never);
    }
    if (req.method === 'POST' && url.pathname === '/workflows/trigger') {
      return workflowsTriggerRoute(req, opts.services as never);
    }
    if (req.method === 'GET' && url.pathname === '/workflows/history') {
      return workflowsHistoryRoute(req, opts.services as never);
    }
    if (req.method === 'POST' && url.pathname === '/workflows/suggest') {
      return workflowsSuggestRoute(req, opts.services as never);
    }
    if (url.pathname === '/worktrees') {
      if (req.method === 'GET') return worktreesListRoute(req, opts.services);
    }
    const worktreeMatch = url.pathname.match(/^\/worktrees\/([^/]+)$/);
    if (worktreeMatch && req.method === 'GET') {
      return worktreesInspectRoute(req, worktreeMatch[1]!, opts.services);
    }
    const worktreeCleanupMatch = url.pathname.match(/^\/worktrees\/([^/]+)\/cleanup$/);
    if (worktreeCleanupMatch && req.method === 'POST') {
      return worktreesCleanupRoute(req, worktreeCleanupMatch[1]!, opts.services);
    }
    const worktreeGlobMatch = url.pathname.match(/^\/worktrees\/([^/]+)\/glob$/);
    if (worktreeGlobMatch && req.method === 'POST') {
      return worktreesGlobRoute(req, worktreeGlobMatch[1]!, opts.services);
    }
    const worktreeGrepMatch = url.pathname.match(/^\/worktrees\/([^/]+)\/grep$/);
    if (worktreeGrepMatch && req.method === 'POST') {
      return worktreesGrepRoute(req, worktreeGrepMatch[1]!, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/handoffs') {
      return handoffsListPendingRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/handoffs/latest') {
      return handoffsLatestRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/handoffs/pending') {
      return handoffsListPendingRoute(req, opts.services);
    }
    const approveMatch = url.pathname.match(/^\/handoffs\/([^/]+)\/approve$/);
    if (req.method === 'POST' && approveMatch) {
      return handoffsApproveRoute(req, approveMatch[1]!, opts.services);
    }
    const claimMatch = url.pathname.match(/^\/handoffs\/([^/]+)\/claim$/);
    if (req.method === 'POST' && claimMatch) {
      return handoffsClaimRoute(req, claimMatch[1]!, opts.services);
    }
    const handoffStatusMatch = url.pathname.match(/^\/handoffs\/([^/]+)\/status$/);
    if (req.method === 'GET' && handoffStatusMatch) {
      return handoffsStatusRoute(req, handoffStatusMatch[1]!, opts.services);
    }
    const handoffGetMatch = url.pathname.match(/^\/handoffs\/([^/]+)$/);
    if (req.method === 'GET' && handoffGetMatch) {
      return handoffsGetRoute(req, handoffGetMatch[1]!, opts.services);
    }
    const progressMatch = url.pathname.match(/^\/handoffs\/([^/]+)\/progress$/);
    if (req.method === 'POST' && progressMatch) {
      return handoffsProgressRoute(req, progressMatch[1]!, opts.services);
    }
    const completeMatch = url.pathname.match(/^\/handoffs\/([^/]+)\/complete$/);
    if (req.method === 'POST' && completeMatch) {
      return handoffsCompleteRoute(req, completeMatch[1]!, opts.services);
    }
    const failMatch = url.pathname.match(/^\/handoffs\/([^/]+)\/fail$/);
    if (req.method === 'POST' && failMatch) {
      return handoffsFailRoute(req, failMatch[1]!, opts.services);
    }
    const taskCancelMatch = url.pathname.match(/^\/tasks\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && taskCancelMatch) {
      return tasksCancelRoute(req, taskCancelMatch[1]!, taskWriter, ghTaskSyncService);
    }
    const taskLinkGhMatch = url.pathname.match(/^\/tasks\/([^/]+)\/link-gh$/);
    if (req.method === 'POST' && taskLinkGhMatch) {
      return tasksLinkGhRoute(req, taskLinkGhMatch[1]!, taskWriter, ghTaskSyncService);
    }
    // Keep GH task subroutes kebab-case for consistency with /link-gh and /unlink-gh.
    const taskCommentGhMatch = url.pathname.match(/^\/tasks\/([^/]+)\/comment-gh$/);
    if (req.method === 'POST' && taskCommentGhMatch) {
      return tasksCommentGhRoute(req, taskCommentGhMatch[1]!, ghTaskSyncService);
    }
    const taskCommentGhLegacyMatch = url.pathname.match(/^\/tasks\/([^/]+)\/comment_gh$/);
    if (req.method === 'POST' && taskCommentGhLegacyMatch) {
      return tasksCommentGhRoute(req, taskCommentGhLegacyMatch[1]!, ghTaskSyncService);
    }
    const taskUnlinkGhMatch = url.pathname.match(/^\/tasks\/([^/]+)\/unlink-gh$/);
    if (req.method === 'POST' && taskUnlinkGhMatch) {
      return tasksUnlinkGhRoute(req, taskUnlinkGhMatch[1]!, taskWriter);
    }
    if (req.method === 'POST' && url.pathname === '/tasks/sync-gh-now') {
      return tasksSyncGhNowRoute(req, ghTaskSyncService);
    }
    const taskHeartbeatMatch = url.pathname.match(/^\/tasks\/([^/]+)\/heartbeat$/);
    if (req.method === 'POST' && taskHeartbeatMatch) {
      return tasksHeartbeatRoute(req, taskHeartbeatMatch[1]!, taskWriter);
    }
    const taskCompleteMatch = url.pathname.match(/^\/tasks\/([^/]+)\/complete$/);
    if (req.method === 'POST' && taskCompleteMatch) {
      return tasksCompleteRoute(req, taskCompleteMatch[1]!, taskWriter, ghTaskSyncService);
    }
    const taskFailMatch = url.pathname.match(/^\/tasks\/([^/]+)\/fail$/);
    if (req.method === 'POST' && taskFailMatch) {
      return tasksFailRoute(req, taskFailMatch[1]!, taskWriter, ghTaskSyncService);
    }
    const taskGetMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
    if (req.method === 'GET' && taskGetMatch) {
      return tasksGetRoute(req, taskGetMatch[1]!, taskWriter);
    }
    if (req.method === 'POST' && url.pathname === '/permissions') {
      return permissionsCreateRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/mcp-events/publish') {
      return mcpEventsPublishRoute(req);
    }
    if (req.method === 'GET' && url.pathname === '/permissions') {
      return permissionsListRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/permissions/events') {
      return permissionsEventsRoute(req, opts.services);
    }
    const permissionGetMatch = url.pathname.match(/^\/permissions\/([^/]+)$/);
    if (permissionGetMatch && req.method === 'GET') {
      return permissionsGetRoute(req, permissionGetMatch[1]!, opts.services);
    }
    const permissionDecideMatch = url.pathname.match(/^\/permissions\/([^/]+)\/decide$/);
    if (permissionDecideMatch && req.method === 'POST') {
      return permissionsDecideRoute(req, permissionDecideMatch[1]!, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/sessions/end') {
      return sessionEndRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/sessions/touch') {
      return sessionsTouchRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/session/current') {
      return sessionCurrentRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/chains/start') {
      return chainsStartRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/chains') {
      return chainsListRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/agentchat/reload') {
      return reloadConfigRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/reconciler/sweep-orphan-prs') {
      return reconcilerSweepOrphanPrsRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/reconciler/verdicts') {
      return reconcilerVerdictsRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/chains/history') {
      return chainsHistoryRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/chains/messages') {
      return chainsMessagesRoute(req, opts.services);
    }
    const chainMessageMatch = url.pathname.match(/^\/chains\/([^/]+)\/messages$/);
    if (req.method === 'POST' && chainMessageMatch) {
      return chainSendMessageRoute(req, decodeURIComponent(chainMessageMatch[1]!), opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/chains/responses') {
      return chainsResponsesRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/chains/agents') {
      return chainsListAgentsRoute(req, opts.services);
    }
    const convCancelMatch = url.pathname.match(/^\/conversations\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && convCancelMatch) {
      return conversationsCancelRoute(req, convCancelMatch[1]!, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/plans') {
      return plansRegisterRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/plans') {
      return plansListRoute(req, opts.services);
    }
    const planCancelMatch = url.pathname.match(/^\/plans\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && planCancelMatch) {
      return plansCancelRoute(req, planCancelMatch[1]!, opts.services, taskWriter);
    }
    const planGetMatch = url.pathname.match(/^\/plans\/([^/]+)$/);
    if (req.method === 'GET' && planGetMatch) {
      return plansGetRoute(req, planGetMatch[1]!, opts.services);
    }
    return new Response('not found', { status: 404 });
  };
}

export function serve(opts: ServeOpts): DaemonHandle {
  const daemonServices = opts.services as DaemonServices;
  const watchdog = new WatchdogService(opts.services);
  daemonServices.watchdog = watchdog;

  const rollup = createRollupWorker({
    services: opts.services,
    idleMinutes: opts.services.settings.t1SessionIdleMinutes,
  });
  const promotion = createT2PromotionWorker({
    services: opts.services,
    delayHours: opts.services.settings.t2PromotionDelayHours,
  });
  const retention = createT0RetentionWorker({
    services: opts.services,
    retentionDays: opts.services.settings.t0RetentionDays,
  });
  const sweeper = createHandoffSweeperWorker({
    services: opts.services,
  });
  const efficacyJobRunner = (() => {
    const cfg = resolveJudgeConfig();
    (opts.services.log as any)?.info?.(
      {
        component: 'memory-efficacy',
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        usedDefaultBaseUrl: cfg.usedDefaultBaseUrl,
        usedDefaultModel: cfg.usedDefaultModel,
      },
      'memory-efficacy: judge endpoint resolved',
    );
    const judgeChat = createJudgeChat({
      baseUrl: cfg.baseUrl,
      token: cfg.token,
    });
    return createMemoryEfficacyJobRunner({
      db: opts.services.db,
      services: opts.services,
      judgeChat,
      model: cfg.model,
      intervalMs: 5000,
      log: opts.services.log as any,
    });
  })();
  const stopPermissionSweeper = startPermissionTtlSweeper(opts.services);
  const stopOrphanLanesSweeper = startOrphanLanesSweeper(opts.services);
  const stopStaleWorkerTokensSweeper = startStaleWorkerTokensSweeper({ db: opts.services.db, log: opts.services.log as any });
  const stopStaleHandoffSweeper = startStaleHandoffSweeper({
    services: opts.services,
    resolveStaleAfterMs,
  });
  const strictModeEnv = process.env.PENUMBRA_ORPHAN_HANDOFF_STRICT_MODE;
  if (strictModeEnv !== undefined) {
    opts.services.log.warn(
      { env: 'PENUMBRA_ORPHAN_HANDOFF_STRICT_MODE' },
      'deprecated orphan recovery env var set; use PENUMBRA_ORPHAN_HANDOFF_FAIL_FAST instead'
    );
  }
  const orphanHandoffRecovery = new OrphanHandoffRecoveryService(opts.services, {
    staleMs: Number(process.env.PENUMBRA_WORKER_HEARTBEAT_STALE_MS) || 90000,
    intervalMs: process.env.PENUMBRA_ORPHAN_HANDOFF_RECOVERY_INTERVAL_MS !== undefined ? Number(process.env.PENUMBRA_ORPHAN_HANDOFF_RECOVERY_INTERVAL_MS) : 15000,
    batchSize: Number(process.env.PENUMBRA_ORPHAN_HANDOFF_RECOVERY_BATCH) || 100,
    failFastMode: process.env.PENUMBRA_ORPHAN_HANDOFF_FAIL_FAST === '1' || strictModeEnv === '1',
  });
  daemonServices.orphanHandoffRecovery = orphanHandoffRecovery;
  const stopOrphanHandoffRecovery = orphanHandoffRecovery.start().stop;
  const stopEfficacyJobReclaimSweeper = startEfficacyJobReclaimSweeper({
    services: opts.services,
  });
  const stopReconcilerSweeper = startReconcilerSweeper({
    services: opts.services,
    log: opts.services.log as any,
  });
  const daemonSettings = opts.services.settings as any;
  const prOrphanSweeper = installPrOrphanSweeper({
    db: opts.services.db,
    intervalMs: daemonSettings.prOrphanSweeperIntervalMs ?? 21_600_000,
    dryRun: daemonSettings.prOrphanSweeperDryRun ?? true,
    applyDefault: true,
    t0Writer: opts.services.t0Writer,
    uuid: opts.services.uuid,
    clock: opts.services.clock,
    machineId: opts.services.machineId,
    log: opts.services.log as any,
  });
  const taskCooldowns = new TaskCooldowns();
  opts.services.taskCooldowns = taskCooldowns;
  const taskEvents = new TaskEventBus();
  const resolveAgent = (name: string) => {
    const cfg = opts.services.agentchatConfig;
    return cfg ? getAgentDescriptor(name, cfg as Parameters<typeof getAgentDescriptor>[1]) : undefined;
  };
  const maestroSessions = new MaestroSessionWriter({
    db: opts.services.db,
    now: () => opts.services.clock().getTime(),
  });
  const taskWriter = new TaskWriter(opts.services.db, {
    now: () => opts.services.clock().getTime(),
    cooldowns: taskCooldowns.get(),
    bus: taskEvents,
    resolveAgent,
    maestroSessions,
    onOrchestrateCancel: (chain_handoff_id) =>
      cancelChainByHandoffId(opts.services, chain_handoff_id).catch((err) =>
        console.warn('[task.cancel] chainCancel failed', err),
      ),
  });
  const ghTaskSyncService = createDefaultGhTaskSyncService(opts.services, taskWriter);
  const ghTaskSyncSweeper = createGhTaskSyncSweeper({
    service: ghTaskSyncService,
    log: opts.services.log as any,
  });
  ghTaskSyncSweeper.start();
  opts.services.maestroSessions = maestroSessions;
  opts.services.taskWriter = taskWriter;
  const workerManager = opts.services.workerManager ?? createHttpWorkerManager({
    logWarn: (message) => console.warn(message),
  });
  const acpInjector = createAcpInjector({ workerManager: workerManager as AcpWorkerManagerLike });
  const boundsCallbacks = createBoundsCallbacks({
    db: opts.services.db,
    services: opts.services,
    taskWriter,
    sessions: maestroSessions,
    injector: acpInjector,
    bus: taskEvents,
    chainCancel: (chain_handoff_id: string) => cancelChainByHandoffId(opts.services, chain_handoff_id),
    now: () => opts.services.clock().getTime(),
  });
  const boundsTracker = createBoundsTracker({
    db: opts.services.db,
    sessions: maestroSessions,
    intervalMs: 5_000,
    warnThreshold: 0.8,
    now: () => opts.services.clock().getTime(),
    onSoftWarn: boundsCallbacks.onSoftWarn,
    onPressureSoftWarn: boundsCallbacks.onPressureSoftWarn,
    onHardKill: boundsCallbacks.onHardKill,
    evaluatePressure: boundsCallbacks.evaluatePressure,
  });
  // Plan-runtime registers BEFORE orchestrate-reactor so task.completed events
  // flip plan-task status before any sibling spawn fires.
  const planRuntimeSweeper = createPlanRuntimeSweeper({
    db: opts.services.db,
    plans: opts.services.planWriter,
    taskWriter,
    worktreeManager: opts.services.worktreeManager,
    log: opts.services.log as any,
    now: () => opts.services.clock().getTime(),
  });
  planRuntimeSweeper.start();
  const planRuntimeUnsub = planRuntimeSweeper.subscribe(taskEvents);
  const orchestrateReactor = createOrchestrateReactor({
    db: opts.services.db,
    bus: taskEvents,
    sessions: maestroSessions,
    taskWriter,
    chainStart: async (request: ChainStartRequest) => {
      const response = await chainStartInternal(request, opts.services, { applyMaestroBudgetGate: false });
      if (!response.ok) {
        const bodyText = await response.text();
        let body: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(bodyText) as unknown;
          if (typeof parsed === 'object' && parsed !== null) {
            body = parsed as Record<string, unknown>;
          }
        } catch {
          body = null;
        }
        const error = new Error(`chain_start failed (${response.status}): ${bodyText}`) as Error & {
          status?: number;
          bodyText?: string;
          body?: Record<string, unknown> | null;
        };
        error.status = response.status;
        error.bodyText = bodyText;
        error.body = body;
        throw error;
      }
      const data = await response.json() as { handoff_id?: unknown; conversation_id?: unknown };
      if (typeof data.handoff_id !== 'string' || typeof data.conversation_id !== 'string') {
        throw new Error('chain_start returned malformed response');
      }
      return { handoff_id: data.handoff_id, conversation_id: data.conversation_id };
    },
    resolveAgent,
    defaults: {
      wall_clock_ms: 1_800_000,
      cost_cents: 200,
      sub_dispatches: 10,
    },
    now: () => opts.services.clock().getTime(),
  });
  const orchestrateDeferralSweeper = createOrchestrateDeferralSweeper({
    db: opts.services.db,
    bus: taskEvents,
    now: () => opts.services.clock().getTime(),
  });
  const mcpPool = createMcpPool({ log: opts.services.log.child({ component: 'mcp-pool' }) });
  const { executeTool, takeSnapshot } = buildActionGateCallbacks({
    db: opts.services.db,
    mcpPool,
    log: opts.services.log,
  });
  const actionGate = createActionGate({
    db: opts.services.db,
    executeTool,
    takeSnapshot,
    now: () => opts.services.clock().getTime(),
  });
  const longLivedReactor = createLongLivedReactor({
    db: opts.services.db,
    bus: getMcpEventBus(),
    now: () => opts.services.clock().getTime(),
    mcpPool,
    loadAgentchatYaml: async () => {
      const cfg = opts.services.agentchatConfig;
      return { agents: Array.isArray(cfg?.agents) ? cfg.agents : [] };
    },
    isChainActive: (chain_id: string) => {
      const active = opts.services.db.query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n
         FROM handoffs
         WHERE conversation_id = ?
           AND status IN ('approved', 'dispatched')`,
      ).get(chain_id);
      return (active?.n ?? 0) > 0;
    },
    spawn: async (req) => {
      const agentRow = opts.services.db.query<{ agent_name: string; project_id: string | null }, [string]>(
        `SELECT id AS agent_name, project_id
         FROM long_lived_agents
         WHERE id = ?
         LIMIT 1`,
      ).get(req.agent_id);
      if (!agentRow) {
        throw new Error(`unknown long-lived agent: ${req.agent_id}`);
      }

      const response = await chainStartInternal({
        initial_agent: agentRow.agent_name,
        message: `long-lived tick ${req.tick_id}`,
        dispatch_kind: 'long_lived_tick',
        long_lived_agent_id: req.agent_id,
        long_lived_tick_id: req.tick_id,
        project_id: agentRow.project_id ?? 'penumbra',
        use_worktree: false,
        max_hops: 1,
      }, opts.services, { applyMaestroBudgetGate: false });
      if (!response.ok) {
        const bodyText = await response.text();
        throw new Error(`long-lived chain_start failed (${response.status}): ${bodyText}`);
      }
      const body = await response.json() as { conversation_id?: unknown };
      if (typeof body.conversation_id !== 'string') {
        throw new Error('long-lived chain_start returned malformed response');
      }
      return { chain_id: body.conversation_id };
    },
  });
  opts.services.mcpPool = mcpPool;
  opts.services.actionGate = actionGate;
  opts.services.longLivedReactor = longLivedReactor;
  // Guard: if stop() is called before the async startup completes (common in tests),
  // skip start() calls to prevent intervals firing against a closed DB.
  let startupStopped = false;
  void (async () => {
    try {
      await runRestartResume({
        db: opts.services.db,
        sessions: maestroSessions,
        taskWriter,
        isChainAlive: async (chain_handoff_id: string) => {
          try {
            return Boolean(await workerManager.lookupSession(chain_handoff_id));
          } catch {
            return false;
          }
        },
        // Hook reserved for future in-memory tracker state restore.
        attachToTracker: () => {},
        bus: taskEvents,
        now: () => opts.services.clock().getTime(),
      });
    } catch (error) {
      console.warn('[serve] restart-resume failed; continuing startup', error);
    }

    try {
      await longLivedReactor.reload();
    } catch (error) {
      console.warn('[serve] long-lived reactor reload failed; continuing startup', error);
    }
    if (!startupStopped) {
      boundsTracker.start();
      orchestrateReactor.start();
      orchestrateDeferralSweeper.start();
    }
  })();
  const taskLeaseSweeper = createTaskLeaseSweeper({
    db: opts.services.db,
    now: () => opts.services.clock().getTime(),
    cooldowns: taskCooldowns,
    bus: taskEvents,
  });
  taskLeaseSweeper.start();
  const stopWorkflowSweeper = (() => {
    const reg = opts.services.workflowRegistry;
    if (!reg) {
      return () => {};
    }
    const cwd = process.cwd();
    let project = 'unknown';
    try {
      const resolved = resolveProjectId({ cwd });
      if (resolved.project_id) project = resolved.project_id;
    } catch {}
    return startWorkflowTriggerSweeper({
      registry: reg,
      computeMetrics: (now) => computeStateMetrics({ db: opts.services.db, now }),
      runWorkflow: async (name) => {
        await runWorkflowTriggerEntry(opts, name, cwd, project);
      },
      log: opts.services.log as any,
    });
  })();

  opts.services.supervisor.register({
    name: 't1-rollup',
    intervalMs: opts.services.settings.t1RollupIntervalSec * 1000,
    tick: rollup.tick,
  });
  opts.services.supervisor.register({
    name: 't2-promotion',
    intervalMs: Math.max(opts.services.settings.t1RollupIntervalSec, 300) * 1000,
    tick: promotion.tick,
  });
  opts.services.supervisor.register({
    name: 't0-retention',
    intervalMs: 3600 * 1000,
    tick: retention.tick,
  });
  opts.services.supervisor.register({
    name: 'handoff-sweeper',
    intervalMs: 60 * 1000,
    tick: sweeper.tick,
  });
  opts.services.supervisor.register({
    name: 'worker-watchdog',
    intervalMs: 15_000,
    tick: watchdog.tick,
  });
  void opts.services.supervisor.startAll();
  efficacyJobRunner.start();

  const fetchHandler = createDaemonFetchHandler({
    services: opts.services,
    token: opts.token,
    taskEvents,
    taskWriter,
    ghTaskSyncService,
    orphanHandoffRecovery,
  });
  const hostname = opts.hostname?.trim() || process.env.PENUMBRA_DAEMON_HOST?.trim() || '127.0.0.1';
  const server = Bun.serve({
    hostname,
    port: opts.port,
    fetch: fetchHandler,
    idleTimeout: 255, // 4m15s to accommodate long-running SSE without tokens
  });
  const port = server.port!;
  opts.services.log.info({ port }, 'daemon started');
  return {
    port,
    stop: async () => {
      startupStopped = true;
      opts.services.supervisor.stopAll();
      efficacyJobRunner.stop();
      server.stop(true);
      stopPermissionSweeper();
      stopOrphanLanesSweeper();
      stopStaleWorkerTokensSweeper();
      stopStaleHandoffSweeper();
      stopOrphanHandoffRecovery();
      stopEfficacyJobReclaimSweeper();
      stopReconcilerSweeper();
      prOrphanSweeper.stop();
      taskLeaseSweeper.stop();
      boundsTracker.stop();
      planRuntimeUnsub();
      planRuntimeSweeper.stop();
      orchestrateDeferralSweeper.stop();
      orchestrateReactor.stop();
      await longLivedReactor.shutdown();
      stopWorkflowSweeper();
      ghTaskSyncSweeper.stop();
      try { opts.onStop?.(); } catch { /* already closed or noop */ }
    },
  };
}
