import { json } from "./_helpers.js";
import type { LagSampler } from "../lag-sampler.js";
import type { Database } from "bun:sqlite";

type HealthRouteOpts = {
  sampler?: LagSampler;
  db?: Database;
  now?: () => Date;
};

export function healthRoute(opts: HealthRouteOpts = {}): Response {
  const payload: Record<string, unknown> = { status: "ok", version: "0.0.0" };
  if (opts.db) {
    const openLanes = opts.db
      .query(
        `SELECT COUNT(*) AS n, MIN(ts_opened) AS oldest
         FROM lane_ledger
         WHERE gate_status = 'open'`,
      )
      .get() as { n: number; oldest: string | null };
    payload.reviewBacklog = {
      open_lanes_count: openLanes.n,
      open_boundary_lanes_count: (
        opts.db
          .query(
            `SELECT COUNT(*) AS n
           FROM lane_ledger
           WHERE gate_status = 'open' AND task_class = 'BOUNDARY'`,
          )
          .get() as { n: number }
      ).n,
      oldest_open_lane_age_ms: openLanes.oldest
        ? Math.max(0, (opts.now?.() ?? new Date()).getTime() - new Date(openLanes.oldest).getTime())
        : 0,
    };
  }
  if (opts.sampler) {
    payload.lagMs = opts.sampler.maxLag;
  }
  return Response.json(payload);
}
