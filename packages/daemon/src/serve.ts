import type { Services } from '@penumbra/core';
import { createBearerAuth } from './auth.js';
import { healthRoute } from './routes/health.js';
import { observationsRoute } from './routes/observations.js';
import { recallRoute } from './routes/recall.js';
import { metricsRoute } from './routes/metrics.js';
import { sessionEndRoute } from './routes/session-end.js';
import {
  handoffsCreateRoute,
  handoffsListPendingRoute,
  handoffsApproveRoute,
  handoffsClaimRoute,
  handoffsCompleteRoute,
  handoffsFailRoute,
} from './routes/handoffs.js';
import { handoffsEventsRoute } from './routes/handoffs-events.js';
import { chainsStartRoute } from './routes/chains.js';
import { createRollupWorker } from './workers/t1-rollup.js';

export interface ServeOpts {
  services: Services;
  token: string;
  port: number;
  /** Called after supervisor and HTTP server are stopped. Use to release resources (e.g. db.close()). */
  onStop?: () => void;
}

export interface DaemonHandle {
  port: number;
  stop(): void;
}

export function serve(opts: ServeOpts): DaemonHandle {
  const auth = createBearerAuth({ token: opts.token });
  const rollup = createRollupWorker({
    services: opts.services,
    idleMinutes: opts.services.settings.t1SessionIdleMinutes,
  });
  opts.services.supervisor.register({
    name: 't1-rollup',
    intervalMs: opts.services.settings.t1RollupIntervalSec * 1000,
    tick: rollup.tick,
  });
  void opts.services.supervisor.startAll();

  const server = Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') return healthRoute();
      const denied = auth(req);
      if (denied) return denied;
      if (req.method === 'POST' && url.pathname === '/observations') {
        return observationsRoute(req, opts.services);
      }
      if (req.method === 'POST' && url.pathname === '/recall') {
        return recallRoute(req, opts.services);
      }
      if (req.method === 'GET' && url.pathname === '/metrics') {
        return metricsRoute(opts.services);
      }
      if (req.method === 'POST' && url.pathname === '/handoffs') {
        return handoffsCreateRoute(req, opts.services);
      }
      if (req.method === 'GET' && url.pathname === '/handoffs/events') {
        return handoffsEventsRoute(req, opts.services);
      }
      if (req.method === 'GET' && url.pathname === '/handoffs') {
        return handoffsListPendingRoute(req, opts.services);
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
      const completeMatch = url.pathname.match(/^\/handoffs\/([^/]+)\/complete$/);
      if (req.method === 'POST' && completeMatch) {
        return handoffsCompleteRoute(req, completeMatch[1]!, opts.services);
      }
      const failMatch = url.pathname.match(/^\/handoffs\/([^/]+)\/fail$/);
      if (req.method === 'POST' && failMatch) {
        return handoffsFailRoute(req, failMatch[1]!, opts.services);
      }
      if (req.method === 'POST' && url.pathname === '/sessions/end') {
        return sessionEndRoute(req, opts.services);
      }
      if (req.method === 'POST' && url.pathname === '/chains/start') {
        return chainsStartRoute(req, opts.services);
      }
      return new Response('not found', { status: 404 });
    },
  });
  const port = server.port!;
  opts.services.log.info({ port }, 'daemon started');
  return {
    port,
    stop: () => {
      opts.services.supervisor.stopAll();
      server.stop(true);
      try { opts.onStop?.(); } catch { /* already closed or noop */ }
    },
  };
}
