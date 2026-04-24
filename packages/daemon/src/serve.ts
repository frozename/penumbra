import type { Services } from '@penumbra/core';
import { createBearerAuth } from './auth.js';
import { healthRoute } from './routes/health.js';

export interface ServeOpts {
  services: Services;
  token: string;
  port: number;
}

export interface DaemonHandle {
  port: number;
  stop(): void;
}

export function serve(opts: ServeOpts): DaemonHandle {
  const auth = createBearerAuth({ token: opts.token });
  const server = Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') return healthRoute();
      const denied = auth(req);
      if (denied) return denied;
      return new Response('not found', { status: 404 });
    },
  });
  const port = server.port!;
  opts.services.log.info({ port }, 'daemon started');
  return {
    port,
    stop: () => server.stop(true),
  };
}
