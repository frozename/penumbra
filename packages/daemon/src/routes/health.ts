import type { Database } from "bun:sqlite";

import type { LagSampler } from "../lag-sampler.js";
import type { LlmRoleFloorEvaluation } from "../services/subsystem-health.js";
import type { T2PromotionStatus } from "../workers/t2-promotion.js";

// Mirrors T2_EMPTY_EXTRACTION_SUBSYSTEM in packages/core/src/writers/t2.ts; the
// core index sits at the max-lines cap, so the constant cannot be re-exported.
const T2_EMPTY_EXTRACTION_SUBSYSTEM = "t2.promotion.empty_extraction";
const T2_EMPTY_EXTRACTION_UNHEALTHY_THRESHOLD = 50;

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
    payload.t2Promotion =
      opts.t2Promotion.enabled && opts.db
        ? withT2EmptyExtractionStreak(opts.t2Promotion, opts.db)
        : opts.t2Promotion;
  }
  return Response.json(payload);
}

function withT2EmptyExtractionStreak(status: T2PromotionStatus, db: Database): T2PromotionStatus {
  const streak =
    db
      .query<
        { consecutive_failures: number },
        [string]
      >("SELECT consecutive_failures FROM subsystem_health WHERE subsystem = ?")
      .get(T2_EMPTY_EXTRACTION_SUBSYSTEM)?.consecutive_failures ?? 0;
  return {
    ...status,
    empty_extraction_streak: streak,
    healthy: streak < T2_EMPTY_EXTRACTION_UNHEALTHY_THRESHOLD,
  };
}
