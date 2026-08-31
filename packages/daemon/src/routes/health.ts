import type { Database } from "bun:sqlite";

import type { LagSampler } from "../lag-sampler.js";
import type { LlmRoleFloorEvaluation } from "../services/subsystem-health.js";
import type { T2PromotionStatus } from "../workers/t2-promotion.js";

type HealthRouteOpts = {
  sampler?: LagSampler;
  db?: Database;
  now?: () => Date;
  llmRoleFloors?: LlmRoleFloorEvaluation;
  t2Promotion?: T2PromotionStatus;
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
    payload.lagMs = opts.sampler.maxLagMs;
  }
  if (opts.llmRoleFloors) {
    payload.llmRoleFloors = opts.llmRoleFloors;
  }
  if (opts.t2Promotion) {
    payload.t2Promotion = opts.t2Promotion;
  }
  return Response.json(payload);
}
