import { resolveProjectId, type Services } from '@penumbra/core';
import { TaskCooldowns } from '../../core/src/tasks/cooldowns.js';
import { composeRecall, executeWorkflow, computeStateMetrics, type TemplateVarContext } from '@penumbra/workflows';
import { createBearerAuth } from './auth.js';
import { healthRoute } from './routes/health.js';
import { observationsRoute } from './routes/observations.js';
import { recallRoute } from './routes/recall.js';
import {
  memorySearchRoute,
  memoryTimelineRoute,
  memoryGetRoute,
  memoryCorpusBuildRoute,
  memoryCorpusQueryRoute,
  memoryCorpusListRoute,
  memoryStatusRoute,
} from './routes/memory.js';
import { usageRecentRoute, usageQuotaStatusRoute } from './routes/usage.js';
import {
  agentsPerformanceDispatchRoute,
  agentsPerformanceImportMarkdownRoute,
  agentsPerformanceMarkdownRoute,
  agentsPerformanceOperatorRoute,
  agentsPerformanceReconcilerRoute,
  agentsRankRoute,
  agentsRecommendRoute,
} from './routes/agents.js';
import { metricsRoute } from './routes/metrics.js';
import { sessionEndRoute } from './routes/session-end.js';
import { sessionsTouchRoute } from './routes/sessions.js';
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
import { dispatchAuditRoute } from './routes/dispatch-audit.js';
import { dispatchEventsGetRoute, dispatchEventsPostRoute } from './routes/dispatch-events.js';
import { worktreesListRoute, worktreesInspectRoute, worktreesCleanupRoute } from './routes/worktrees.js';
import {
  workflowsListRoute,
  workflowsRunRoute,
  workflowsTriggerRoute,
  workflowsHistoryRoute,
  workflowsSuggestRoute,
} from './routes/workflows.js';
import { worktreesGlobRoute, worktreesGrepRoute } from './routes/fs.js';
import { reloadConfigRoute } from './routes/reload-config.js';
import { otlpLogsRoute, otlpMetricsRoute, otlpTracesRoute } from './routes/otlp.js';
import { chainsStartRoute, chainsHistoryRoute, chainsResponsesRoute, chainsListAgentsRoute, chainsMessagesRoute } from './routes/chains.js';
import { shellCloseRoute, shellListRoute, shellRunRoute } from './routes/shell.js';
import {
  permissionsCreateRoute,
  permissionsGetRoute,
  permissionsListRoute,
  permissionsDecideRoute,
} from './routes/permissions.js';
import { permissionsEventsRoute } from './routes/permissions-events.js';
import { startPermissionTtlSweeper } from './sweepers/permission-ttl.js';
import { startWorkflowTriggerSweeper } from './sweepers/workflow-trigger.js';
import { startStaleHandoffSweeper } from './sweepers/stale-handoff.js';
import { createTaskLeaseSweeper } from './sweepers/task-leases.js';
import { createRollupWorker } from './workers/t1-rollup.js';
import { createT2PromotionWorker } from './workers/t2-promotion.js';
import { createT0RetentionWorker } from './workers/t0-retention.js';
import { createHandoffSweeperWorker } from './workers/handoff-sweeper.js';
import { WatchdogService } from './services/watchdog.js';

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
  stop(): void;
}

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
  };
  const bundle = await composeRecall({
    db: opts.services.db,
    embedder: opts.services.embedder,
    cwd,
    project,
    sources: entry.spec.recall,
    budgetTokens: entry.spec.recall_budget_tokens,
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

export function createDaemonFetchHandler(opts: { services: Services; token: string }): (req: Request) => Promise<Response> {
  const auth = createBearerAuth({ token: opts.token });
  return async (req: Request) => {
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
    if (req.method === 'POST' && url.pathname === '/recall') {
      return recallRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/memory/search') {
      return memorySearchRoute(req, opts.services);
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
    if (req.method === 'GET' && url.pathname === '/memory/status') {
      return memoryStatusRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/usage/recent') {
      return usageRecentRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/usage/quota_status') {
      return usageQuotaStatusRoute(req, opts.services);
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
    if (req.method === 'GET' && url.pathname === '/metrics') {
      return metricsRoute(opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/handoffs') {
      return handoffsCreateRoute(req, opts.services);
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
    if (req.method === 'POST' && url.pathname === '/worker/heartbeat') {
      return workerHeartbeatRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/dispatch/events') {
      return dispatchEventsPostRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/dispatch/audit') {
      return dispatchAuditRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/dispatch/events') {
      return dispatchEventsGetRoute(req, opts.services);
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
    if (req.method === 'POST' && url.pathname === '/permissions') {
      return permissionsCreateRoute(req, opts.services);
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
    if (req.method === 'POST' && url.pathname === '/chains/start') {
      return chainsStartRoute(req, opts.services);
    }
    if (req.method === 'POST' && url.pathname === '/agentchat/reload') {
      return reloadConfigRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/chains/history') {
      return chainsHistoryRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/chains/messages') {
      return chainsMessagesRoute(req, opts.services);
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
    return new Response('not found', { status: 404 });
  };
}

export function serve(opts: ServeOpts): DaemonHandle {
  const watchdog = new WatchdogService(opts.services);
  (opts.services as any).watchdog = watchdog;

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
  const stopPermissionSweeper = startPermissionTtlSweeper(opts.services);
  const stopStaleHandoffSweeper = startStaleHandoffSweeper({
    services: opts.services,
    staleAfterMs: 15 * 60_000,
  });
  const taskCooldowns = new TaskCooldowns();
  (opts.services as Services & { taskCooldowns?: TaskCooldowns }).taskCooldowns = taskCooldowns;
  const taskLeaseSweeper = createTaskLeaseSweeper({
    db: opts.services.db,
    now: () => opts.services.clock().getTime(),
    cooldowns: taskCooldowns,
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

  const fetchHandler = createDaemonFetchHandler({ services: opts.services, token: opts.token });
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
    stop: () => {
      opts.services.supervisor.stopAll();
      server.stop(true);
      stopPermissionSweeper();
      stopStaleHandoffSweeper();
      taskLeaseSweeper.stop();
      stopWorkflowSweeper();
      try { opts.onStop?.(); } catch { /* already closed or noop */ }
    },
  };
}
