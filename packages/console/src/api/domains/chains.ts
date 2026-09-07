import type { z } from "zod";

import { ChainsListResponseSchema, type HandoffStatus } from "@penumbra/api-contract";

import type { DaemonTransport } from "../transport.js";

import { fillPath } from "../paths.js";

export const PATHS = { list: "/chains" } as const;

export type ChainsListResponse = z.infer<typeof ChainsListResponseSchema>;

export interface ChainsSlice {
  list(opts?: {
    status?: HandoffStatus;
    limit?: number;
    offset?: number;
    projectId?: string;
  }): Promise<ChainsListResponse>;
}

export function chainsSlice(t: DaemonTransport): ChainsSlice {
  return {
    list(opts?: {
      status?: HandoffStatus;
      limit?: number;
      offset?: number;
      projectId?: string;
    }): Promise<ChainsListResponse> {
      return t.request({
        path: fillPath(PATHS.list),
        query: {
          status: opts?.status,
          limit: opts?.limit,
          offset: opts?.offset,
          project_id: opts?.projectId,
        },
        schema: ChainsListResponseSchema,
      });
    },
  };
}
