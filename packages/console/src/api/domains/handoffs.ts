import type { z } from "zod";

import {
  type ApproveHandoffResponse,
  ApproveHandoffResponseSchema,
  HandoffsListResponseSchema,
  type HandoffStatus,
} from "@penumbra/api-contract";

import type { DaemonTransport } from "../transport.js";

import { fillPath } from "../paths.js";

export const PATHS = { list: "/handoffs", approve: "/handoffs/:id/approve" } as const;

export type HandoffsListResponse = z.infer<typeof HandoffsListResponseSchema>;

export interface ApproveHandoffOpts {
  reject?: boolean;
  reason?: string;
  redirectTo?: string;
  resolvedBy?: string;
}

export interface HandoffsSlice {
  list(opts?: { status?: HandoffStatus }): Promise<HandoffsListResponse>;
  approve(id: string, opts?: ApproveHandoffOpts): Promise<ApproveHandoffResponse>;
}

export function handoffsSlice(t: DaemonTransport): HandoffsSlice {
  return {
    list(opts?: { status?: HandoffStatus }): Promise<HandoffsListResponse> {
      return t.request({
        path: fillPath(PATHS.list),
        query: { status: opts?.status },
        schema: HandoffsListResponseSchema,
      });
    },
    approve(id: string, opts?: ApproveHandoffOpts): Promise<ApproveHandoffResponse> {
      const body: Record<string, unknown> = {};
      if (opts?.reject !== undefined) body.reject = opts.reject;
      if (opts?.reason !== undefined) body.reason = opts.reason;
      if (opts?.redirectTo !== undefined) body.redirect_to = opts.redirectTo;
      if (opts?.resolvedBy !== undefined) body.resolved_by = opts.resolvedBy;
      return t.request({
        method: "POST",
        path: fillPath(PATHS.approve, { id }),
        body,
        schema: ApproveHandoffResponseSchema,
      });
    },
  };
}
