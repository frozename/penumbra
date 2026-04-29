import type { Services } from '@penumbra/core';
import { createBearerAuth } from './auth.js';
import { healthRoute } from './routes/health.js';
import { observationsRoute } from './routes/observations.js';
import { recallRoute } from './routes/recall.js';
import { usageRecentRoute, usageQuotaStatusRoute } from './routes/usage.js';
import { metricsRoute } from './routes/metrics.js';
import { sessionEndRoute } from './routes/session-end.js';
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
import { worktreesListRoute, worktreesInspectRoute, worktreesCleanupRoute } from './routes/worktrees.js';
import { worktreesGlobRoute, worktreesGrepRoute } from './routes/fs.js';
import { reloadConfigRoute } from './routes/reload-config.js';
import { otlpLogsRoute, otlpMetricsRoute, otlpTracesRoute } from './routes/otlp.js';
import { chainsStartRoute, chainsHistoryRoute, chainsResponsesRoute, chainsListAgentsRoute, chainsMessagesRoute } from './routes/chains.js';
import {
  permissionsCreateRoute,
  permissionsGetRoute,
  permissionsListRoute,
  permissionsDecideRoute,
} from './routes/permissions.js';
import { permissionsEventsRoute } from './routes/permissions-events.js';
import { startPermissionTtlSweeper } from './sweepers/permission-ttl.js';
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
    if (req.method === 'GET' && url.pathname === '/usage/recent') {
      return usageRecentRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/usage/quota_status') {
      return usageQuotaStatusRoute(req, opts.services);
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
      try { opts.onStop?.(); } catch { /* already closed or noop */ }
    },
  };
}
