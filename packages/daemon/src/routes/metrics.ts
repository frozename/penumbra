import type { Services } from '@penumbra/core';

const startedAt = Date.now();

export function metricsRoute(services: Services): Response {
  const count = (t: string): number =>
    services.db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM ${t}`).get()?.c ?? 0;
  return Response.json({
    version: '0.0.0',
    uptime_sec: Math.floor((Date.now() - startedAt) / 1000),
    embedder: { name: services.embedder.name, dim: services.embedder.dim },
    counts: {
      t0_events: count('t0_events'),
      t1_rollups: count('t1_rollups'),
      t2_memories: count('t2_memories'),
      recall_audit: count('recall_audit'),
    },
  });
}
