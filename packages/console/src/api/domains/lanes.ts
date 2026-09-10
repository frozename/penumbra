import {
  type CloseLaneRequest,
  CloseLaneRequestSchema,
  type LaneRow,
  type LanesRecentResponse,
  LanesRecentResponseSchema,
  type RecentLaneQueryInput,
  RecentLaneQuerySchema,
} from "@penumbra/api-contract";

import type { DaemonTransport } from "../transport.js";

import { DaemonContractError } from "../errors.js";
import { fillPath } from "../paths.js";

export const PATHS = {
  recent: "/lanes/recent",
  close: "/lanes/close",
} as const;

const LANE_ROW_SCHEMA = LanesRecentResponseSchema.shape.lanes.element;

export interface LanesSlice {
  recent(query?: RecentLaneQueryInput): Promise<LanesRecentResponse>;
  close(body: CloseLaneRequest): Promise<LaneRow>;
}

export function lanesSlice(t: DaemonTransport): LanesSlice {
  return {
    recent(query: RecentLaneQueryInput = {}): Promise<LanesRecentResponse> {
      const parsed = RecentLaneQuerySchema.safeParse(query);
      if (!parsed.success) {
        throw new DaemonContractError({
          url: fillPath(PATHS.recent),
          issues: parsed.error.issues,
          rawBody: query,
        });
      }
      return t.request({
        path: fillPath(PATHS.recent),
        query: {
          status: parsed.data.status,
          task_class: parsed.data.task_class,
          since: parsed.data.since,
          limit: parsed.data.limit,
        },
        schema: LanesRecentResponseSchema,
      });
    },
    close(body: CloseLaneRequest): Promise<LaneRow> {
      const parsed = CloseLaneRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw new DaemonContractError({
          url: fillPath(PATHS.close),
          issues: parsed.error.issues,
          rawBody: body,
        });
      }
      return t.request({
        method: "POST",
        path: fillPath(PATHS.close),
        body: parsed.data,
        schema: LANE_ROW_SCHEMA,
      });
    },
  };
}
